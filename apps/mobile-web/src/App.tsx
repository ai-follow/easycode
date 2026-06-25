import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ClaimPairingResponseSchema,
  PAIRING_REVOKED_CLOSE_CODE,
  PAIRING_REVOKED_CLOSE_REASON,
  RelayEnvelopeSchema,
  type InteractionRequest,
  type RelayEnvelope,
  type RelayPayload
} from "@easycode/protocol";
import { buildMobileWebSocketUrl, nextReconnectAttempt, reconnectDelayMs } from "./mobileConnection.js";
import { createMobileE2eeSessionStore, MobileE2eeSessionManager } from "./mobileE2eeSession.js";
import { MobileOutbox } from "./mobileOutbox.js";
import { applyMobileRelayPayload, emptyMobileRelayState, removePendingInteraction } from "./mobileRelayState.js";
import {
  lastSeqKey,
  loadStoredPairing,
  pairingStorageKey,
  storePairing
} from "./mobileStorage.js";

type ConnectionState = "disconnected" | "claiming" | "connecting" | "connected" | "error";

const defaultServer = `${window.location.protocol}//${window.location.hostname}:8787`;
const mobileSendQueueLimit = 200;

export const App = () => {
  const [serverUrl, setServerUrl] = useState(defaultServer);
  const [pairingCode, setPairingCode] = useState("");
  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState("");
  const [pairId, setPairId] = useState("");
  const [mobileToken, setMobileToken] = useState("");
  const [mobileState, setMobileState] = useState(emptyMobileRelayState);
  const [draft, setDraft] = useState("");
  const [pendingOutboundCount, setPendingOutboundCount] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const lastServerSeqRef = useRef(0);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const outboxRef = useRef(new MobileOutbox(mobileSendQueueLimit));
  const e2eeManagerRef = useRef<MobileE2eeSessionManager | null>(null);
  if (!e2eeManagerRef.current) {
    e2eeManagerRef.current = new MobileE2eeSessionManager(createMobileE2eeSessionStore(window.localStorage));
  }
  const e2eeManager = e2eeManagerRef.current;

  const { sessions, selectedSessionId } = mobileState;
  const selected = selectedSessionId ? sessions[selectedSessionId] : undefined;
  const latestDelivery = selected?.deliveries.at(-1);

  const canSend = status === "connected" && Boolean(selectedSessionId) && draft.trim().length > 0;

  const statusText = useMemo(() => {
    switch (status) {
      case "claiming":
        return "Claiming pairing code";
      case "connecting":
        return "Connecting";
      case "connected":
        return "Connected";
      case "error":
        return "Error";
      default:
        return "Disconnected";
    }
  }, [status]);

  useEffect(() => {
    const stored = loadStoredPairing(window.localStorage);
    if (!stored) return;

    setServerUrl(stored.serverUrl);
    setPairId(stored.pairId);
    setMobileToken(stored.mobileToken);
    void connectSocket(stored.pairId, stored.mobileToken, stored.serverUrl);

    return () => {
      if (typeof reconnectTimerRef.current === "number") window.clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close();
      }
    };
  }, []);

  const claimPairing = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStatus("claiming");

    try {
      const response = await fetch(new URL(`/v1/pairings/${pairingCode.trim()}/claim`, serverUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{}"
      });

      if (!response.ok) throw new Error(await response.text());
      const claimed = ClaimPairingResponseSchema.parse(await response.json());
      setPairId(claimed.pairId);
      setMobileToken(claimed.mobileToken);
      storePairing(window.localStorage, {
        serverUrl,
        pairId: claimed.pairId,
        mobileToken: claimed.mobileToken
      });
      await connectSocket(claimed.pairId, claimed.mobileToken, serverUrl);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const connectSocket = async (nextPairId: string, nextMobileToken: string, relayUrl = serverUrl) => {
    if (typeof reconnectTimerRef.current === "number") {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    setStatus("connecting");
    await e2eeManager.restore(nextPairId);
    const rememberedSeq = Number(window.localStorage.getItem(lastSeqKey(nextPairId)) ?? "0");
    lastServerSeqRef.current = Number.isFinite(rememberedSeq) ? rememberedSeq : 0;
    const wsUrl = buildMobileWebSocketUrl({
      relayUrl,
      pairId: nextPairId,
      mobileToken: nextMobileToken,
      afterSeq: lastServerSeqRef.current
    });

    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.close();
    }
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      setStatus("connected");
      setError("");
      flushSendQueue();
    };
    ws.onerror = () => {
      setStatus("error");
      setError("WebSocket connection failed");
    };
    ws.onclose = (event) => {
      if (socketRef.current !== ws) return;
      if (event.code === PAIRING_REVOKED_CLOSE_CODE || event.reason === PAIRING_REVOKED_CLOSE_REASON) {
        clearLocalPairingState(nextPairId, false);
        setStatus("error");
        setError("Pairing was revoked. Connect with a new code.");
        return;
      }
      requeuePendingAcks();
      setStatus("disconnected");
      scheduleReconnect(nextPairId, nextMobileToken, relayUrl);
    };
    ws.onmessage = (message) => {
      const parsedJson = safeJson(String(message.data));
      if (typeof parsedJson === "undefined") {
        setError("Received invalid JSON from relay");
        return;
      }

      const parsed = RelayEnvelopeSchema.safeParse(parsedJson);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      rememberServerSeq(parsed.data);
      void applyEnvelope(parsed.data).catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    };
  };

  const scheduleReconnect = (nextPairId: string, nextMobileToken: string, relayUrl: string) => {
    if (typeof reconnectTimerRef.current === "number") return;
    const attempt = nextReconnectAttempt(reconnectAttemptRef.current);
    reconnectAttemptRef.current = attempt;
    const delayMs = reconnectDelayMs({ attempt });
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = undefined;
      void connectSocket(nextPairId, nextMobileToken, relayUrl);
    }, delayMs);
  };

  const rememberServerSeq = (envelope: RelayEnvelope) => {
    if (typeof envelope.serverSeq !== "number" || envelope.serverSeq <= lastServerSeqRef.current) return;
    lastServerSeqRef.current = envelope.serverSeq;
    window.localStorage.setItem(lastSeqKey(envelope.pairId), String(envelope.serverSeq));
  };

  const applyEnvelope = async (envelope: RelayEnvelope) => {
    if (envelope.payload.kind === "key_exchange") {
      const reply = await e2eeManager.handleKeyExchange(envelope.pairId, envelope.payload);
      sendEnvelope({
        id: `env_${crypto.randomUUID()}`,
        pairId: envelope.pairId,
        source: "mobile",
        createdAt: new Date().toISOString(),
        payload: reply
      });
      return;
    }

    if (envelope.payload.kind === "encrypted_payload") {
      envelope = {
        ...envelope,
        payload: await e2eeManager.decryptEnvelopePayload(envelope)
      };
    }

    const payload = envelope.payload;

    if (payload.kind === "ack") {
      outboxRef.current.ack(payload.refId);
      updatePendingOutboundCount();
      return;
    }

    if (payload.kind === "error") {
      if (payload.refId) {
        outboxRef.current.reject(payload.refId);
        updatePendingOutboundCount();
      }
      setError(payload.refId ? `${payload.message} (${payload.refId})` : payload.message);
      return;
    }

    if (payload.kind === "ping") return;

    if (payload.kind === "desktop_status") {
      applyPayload(payload);
      return;
    }

    if (payload.kind === "session_snapshot") {
      applyPayload(payload);
      return;
    }

    if (payload.kind === "client_event") {
      applyPayload(payload);
    }
  };

  const applyPayload = (payload: RelayPayload) => {
    setMobileState((current) => applyMobileRelayPayload(current, payload));
  };

  const sendPayload = async (payload: RelayPayload): Promise<boolean> => {
    if (!pairId) {
      setError("No active pairing");
      return false;
    }
    const envelope: RelayEnvelope = {
      id: `env_${crypto.randomUUID()}`,
      pairId,
      source: "mobile",
      createdAt: new Date().toISOString(),
      payload
    };

    sendEnvelope(await prepareOutboundEnvelope(envelope));
    return true;
  };

  const prepareOutboundEnvelope = async (envelope: RelayEnvelope): Promise<RelayEnvelope> => {
    return e2eeManager.prepareOutboundEnvelope(envelope);
  };

  const sendEnvelope = (envelope: RelayEnvelope) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      outboxRef.current.enqueue(envelope);
      updatePendingOutboundCount();
      setError("Socket is reconnecting. Message queued.");
      return;
    }

    outboxRef.current.trackPending(envelope);
    updatePendingOutboundCount();
    try {
      ws.send(JSON.stringify(envelope));
    } catch (caught) {
      outboxRef.current.reject(envelope.id);
      outboxRef.current.enqueue(envelope);
      updatePendingOutboundCount();
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const flushSendQueue = () => {
    const queued = outboxRef.current.takeQueued();
    updatePendingOutboundCount();
    for (const envelope of queued) sendEnvelope(envelope);
  };

  const requeuePendingAcks = () => {
    outboxRef.current.requeuePending();
    updatePendingOutboundCount();
  };

  const updatePendingOutboundCount = () => {
    setPendingOutboundCount(outboxRef.current.pendingCount);
  };

  const sendText = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedSessionId) return;
    const sent = await sendPayload({
      kind: "user_input",
      sessionId: selectedSessionId,
      input: {
        type: "text",
        inputId: `input_${crypto.randomUUID()}`,
        text
      }
    });
    if (sent) setDraft("");
  };

  const sendInteractionResponse = async (request: InteractionRequest, optionId: string, value: unknown) => {
    if (!selectedSessionId) return;
    const sent = await sendPayload({
      kind: "user_input",
      sessionId: selectedSessionId,
      input: {
        type: "interaction_response",
        inputId: `input_${crypto.randomUUID()}`,
        requestId: request.id,
        optionId,
        value
      }
    });
    if (!sent) return;

    setMobileState((current) => {
      const previous = current.sessions[selectedSessionId];
      if (!previous) return current;
      return removePendingInteraction(current, selectedSessionId, request.id);
    });
  };

  const forgetPairing = () => {
    const currentPairId = pairId;
    const currentMobileToken = mobileToken;
    const currentServerUrl = serverUrl;

    clearLocalPairingState(currentPairId);
    setError("");
    setStatus("disconnected");

    if (currentPairId && currentMobileToken) {
      void revokePairing(currentServerUrl, currentPairId, currentMobileToken);
    }
  };

  const clearLocalPairingState = (currentPairId = pairId, closeSocket = true) => {
    if (typeof reconnectTimerRef.current === "number") {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    if (socketRef.current && closeSocket) {
      socketRef.current.onclose = null;
      socketRef.current.close();
      socketRef.current = null;
    } else if (!closeSocket) {
      socketRef.current = null;
    }
    if (currentPairId) window.localStorage.removeItem(lastSeqKey(currentPairId));
    e2eeManager.forget(currentPairId);
    window.localStorage.removeItem(pairingStorageKey);
    reconnectAttemptRef.current = 0;
    lastServerSeqRef.current = 0;
    outboxRef.current.clear();
    updatePendingOutboundCount();
    setPairId("");
    setMobileToken("");
    setMobileState(emptyMobileRelayState());
    setDraft("");
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>EasyCode</h1>
          <p>{statusText}</p>
        </div>
        <span className={`dot dot-${status}`} aria-label={statusText} />
      </header>

      {status !== "connected" ? (
        <form className="connect" onSubmit={claimPairing}>
          {pairId && mobileToken ? <p className="hint">Reconnecting to saved pairing...</p> : null}
          <label>
            Relay server
            <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} spellCheck={false} />
          </label>
          <label>
            Pairing code
            <input
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder="123456"
            />
          </label>
          <button type="submit" disabled={pairingCode.length !== 6 || status === "claiming" || status === "connecting"}>
            Connect
          </button>
          {pairId && mobileToken ? (
            <button type="button" className="secondary" onClick={forgetPairing}>
              Forget pairing
            </button>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
        </form>
      ) : (
        <section className="workspace">
          <div className="sessionbar">
            <select
              value={selectedSessionId}
              onChange={(event) => setMobileState((current) => ({
                ...current,
                selectedSessionId: event.target.value
              }))}
            >
              {Object.entries(sessions).map(([id, model]) => (
                <option key={id} value={id}>
                  {model.session?.title ?? id}
                </option>
              ))}
            </select>
            <span>{selected?.state?.status ?? "attached"}</span>
            <button type="button" className="iconlink" onClick={forgetPairing}>
              Forget
            </button>
          </div>
          {error ? <p className="error workspace-error">{error}</p> : null}

          <div className="messages" aria-live="polite">
            {(selected?.messages ?? []).map((message) => (
              <article key={message.id} className={`message message-${message.role}`}>
                <strong>{message.role}</strong>
                <p>{message.text}</p>
              </article>
            ))}

            {(selected?.pendingInteractions ?? []).map((request) => (
              <article key={request.id} className="interaction">
                <strong>client request</strong>
                <p>{request.text}</p>
                <div className="options">
                  {request.options.map((option: InteractionRequest["options"][number]) => (
                    <button key={option.id} type="button" onClick={() => sendInteractionResponse(request, option.id, option.value)}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>

          {latestDelivery ? (
            <p className={`delivery delivery-${latestDelivery.status}`}>
              {latestDelivery.status}: {latestDelivery.detail ?? latestDelivery.inputId}
            </p>
          ) : null}
          {pendingOutboundCount > 0 ? (
            <p className="delivery delivery-queued">
              waiting for relay ack: {pendingOutboundCount}
            </p>
          ) : null}

          <form className="composer" onSubmit={sendText}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message the desktop client"
              rows={2}
            />
            <button type="submit" disabled={!canSend}>
              Send
            </button>
          </form>
        </section>
      )}
    </main>
  );
};

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const revokePairing = async (serverUrl: string, pairId: string, mobileToken: string): Promise<void> => {
  try {
    await fetch(new URL(`/v1/pairings/${pairId}`, serverUrl), {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${mobileToken}`
      }
    });
  } catch {
    // Local forget should still succeed if the relay is already unreachable.
  }
};
