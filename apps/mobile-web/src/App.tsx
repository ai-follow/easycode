import { FormEvent, useMemo, useRef, useState } from "react";
import {
  ClaimPairingResponseSchema,
  RelayEnvelopeSchema,
  type AttachedSession,
  type ClientMessage,
  type DeliveryState,
  type InteractionRequest,
  type RelayEnvelope,
  type RelayPayload,
  type SessionState
} from "@easycode/protocol";

type ConnectionState = "disconnected" | "claiming" | "connecting" | "connected" | "error";

type SessionModel = {
  session?: AttachedSession;
  messages: ClientMessage[];
  pendingInteractions: InteractionRequest[];
  state?: SessionState;
  deliveries: DeliveryState[];
};

const defaultServer = `${window.location.protocol}//${window.location.hostname}:8787`;

export const App = () => {
  const [serverUrl, setServerUrl] = useState(defaultServer);
  const [pairingCode, setPairingCode] = useState("");
  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState("");
  const [pairId, setPairId] = useState("");
  const [mobileToken, setMobileToken] = useState("");
  const [sessions, setSessions] = useState<Record<string, SessionModel>>({});
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const lastServerSeqRef = useRef(0);

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
      connectSocket(claimed.pairId, claimed.mobileToken);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const connectSocket = (nextPairId: string, nextMobileToken: string) => {
    setStatus("connecting");
    const rememberedSeq = Number(window.localStorage.getItem(lastSeqKey(nextPairId)) ?? "0");
    lastServerSeqRef.current = Number.isFinite(rememberedSeq) ? rememberedSeq : 0;
    const wsUrl = new URL("/v1/ws", serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("pairId", nextPairId);
    wsUrl.searchParams.set("role", "mobile");
    wsUrl.searchParams.set("token", nextMobileToken);
    if (lastServerSeqRef.current > 0) wsUrl.searchParams.set("afterSeq", String(lastServerSeqRef.current));

    socketRef.current?.close();
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => setStatus("connected");
    ws.onerror = () => {
      setStatus("error");
      setError("WebSocket connection failed");
    };
    ws.onclose = () => {
      if (socketRef.current === ws) setStatus("disconnected");
    };
    ws.onmessage = (message) => {
      const parsed = RelayEnvelopeSchema.safeParse(JSON.parse(String(message.data)));
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      rememberServerSeq(parsed.data);
      applyEnvelope(parsed.data);
    };
  };

  const rememberServerSeq = (envelope: RelayEnvelope) => {
    if (typeof envelope.serverSeq !== "number" || envelope.serverSeq <= lastServerSeqRef.current) return;
    lastServerSeqRef.current = envelope.serverSeq;
    window.localStorage.setItem(lastSeqKey(envelope.pairId), String(envelope.serverSeq));
  };

  const applyEnvelope = (envelope: RelayEnvelope) => {
    const payload = envelope.payload;

    if (payload.kind === "desktop_status") {
      setSessions((current) => {
        const next = { ...current };
        for (const session of payload.sessions) {
          const existing = next[session.sessionId] ?? {
            session,
            messages: [],
            pendingInteractions: [],
            deliveries: []
          };
          next[session.sessionId] = { ...existing, session };
        }
        if (!selectedSessionId && payload.sessions[0]) setSelectedSessionId(payload.sessions[0].sessionId);
        return next;
      });
      return;
    }

    if (payload.kind === "session_snapshot") {
      setSessions((current) => ({
        ...current,
        [payload.sessionId]: {
          session: current[payload.sessionId]?.session,
          messages: dedupeMessages(payload.snapshot.messages),
          pendingInteractions: payload.snapshot.pendingInteractions,
          state: payload.snapshot.state,
          deliveries: current[payload.sessionId]?.deliveries ?? []
        }
      }));
      if (!selectedSessionId) setSelectedSessionId(payload.sessionId);
      return;
    }

    if (payload.kind === "client_event") {
      setSessions((current) => {
        const previous = current[payload.sessionId] ?? {
          messages: [],
          pendingInteractions: [],
          deliveries: []
        };

        if (payload.event.type === "message") {
          return {
            ...current,
            [payload.sessionId]: {
              ...previous,
              messages: dedupeMessages([...previous.messages, payload.event.payload])
            }
          };
        }

        if (payload.event.type === "interaction_request") {
          return {
            ...current,
            [payload.sessionId]: {
              ...previous,
              pendingInteractions: dedupeInteractions([...previous.pendingInteractions, payload.event.payload])
            }
          };
        }

        if (payload.event.type === "session_state") {
          return {
            ...current,
            [payload.sessionId]: {
              ...previous,
              state: payload.event.payload
            }
          };
        }

        return {
          ...current,
          [payload.sessionId]: {
            ...previous,
            deliveries: [...previous.deliveries, payload.event.payload].slice(-20)
          }
        };
      });
    }
  };

  const sendPayload = (payload: RelayPayload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Socket is not connected");
      return;
    }

    const envelope: RelayEnvelope = {
      id: `env_${crypto.randomUUID()}`,
      pairId,
      source: "mobile",
      createdAt: new Date().toISOString(),
      payload
    };

    ws.send(JSON.stringify(envelope));
  };

  const sendText = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedSessionId) return;
    setDraft("");
    sendPayload({
      kind: "user_input",
      sessionId: selectedSessionId,
      input: {
        type: "text",
        inputId: `input_${crypto.randomUUID()}`,
        text
      }
    });
  };

  const sendInteractionResponse = (request: InteractionRequest, optionId: string, value: unknown) => {
    if (!selectedSessionId) return;
    sendPayload({
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

    setSessions((current) => {
      const previous = current[selectedSessionId];
      if (!previous) return current;
      return {
        ...current,
        [selectedSessionId]: {
          ...previous,
          pendingInteractions: previous.pendingInteractions.filter((item) => item.id !== request.id)
        }
      };
    });
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
          {error ? <p className="error">{error}</p> : null}
        </form>
      ) : (
        <section className="workspace">
          <div className="sessionbar">
            <select value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
              {Object.entries(sessions).map(([id, model]) => (
                <option key={id} value={id}>
                  {model.session?.title ?? id}
                </option>
              ))}
            </select>
            <span>{selected?.state?.status ?? "attached"}</span>
          </div>

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

const dedupeMessages = (messages: ClientMessage[]): ClientMessage[] => {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
};

const dedupeInteractions = (interactions: InteractionRequest[]): InteractionRequest[] => {
  const seen = new Set<string>();
  return interactions.filter((interaction) => {
    if (seen.has(interaction.id)) return false;
    seen.add(interaction.id);
    return true;
  });
};

const lastSeqKey = (pairId: string): string => `easycode:last-server-seq:${pairId}`;
