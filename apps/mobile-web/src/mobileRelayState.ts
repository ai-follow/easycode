import type {
  AttachedSession,
  ClientMessage,
  DeliveryState,
  InteractionRequest,
  RelayPayload,
  SessionState
} from "@easycode/protocol";

export type SessionModel = {
  session?: AttachedSession;
  messages: ClientMessage[];
  pendingInteractions: InteractionRequest[];
  state?: SessionState;
  deliveries: DeliveryState[];
};

export type MobileRelayState = {
  sessions: Record<string, SessionModel>;
  selectedSessionId: string;
};

export const emptyMobileRelayState = (): MobileRelayState => ({
  sessions: {},
  selectedSessionId: ""
});

export const applyMobileRelayPayload = (state: MobileRelayState, payload: RelayPayload): MobileRelayState => {
  if (payload.kind === "desktop_status") {
    const sessions = { ...state.sessions };
    for (const session of payload.sessions) {
      const existing = sessions[session.sessionId] ?? {
        session,
        messages: [],
        pendingInteractions: [],
        deliveries: []
      };
      sessions[session.sessionId] = { ...existing, session };
    }

    return {
      sessions,
      selectedSessionId: state.selectedSessionId || payload.sessions[0]?.sessionId || ""
    };
  }

  if (payload.kind === "session_snapshot") {
    return {
      sessions: {
        ...state.sessions,
        [payload.sessionId]: {
          session: state.sessions[payload.sessionId]?.session,
          messages: dedupeMessages(payload.snapshot.messages),
          pendingInteractions: payload.snapshot.pendingInteractions,
          state: payload.snapshot.state,
          deliveries: state.sessions[payload.sessionId]?.deliveries ?? []
        }
      },
      selectedSessionId: state.selectedSessionId || payload.sessionId
    };
  }

  if (payload.kind !== "client_event") return state;

  const previous = state.sessions[payload.sessionId] ?? {
    messages: [],
    pendingInteractions: [],
    deliveries: []
  };

  if (payload.event.type === "message") {
    return withSession(state, payload.sessionId, {
      ...previous,
      messages: dedupeMessages([...previous.messages, payload.event.payload])
    });
  }

  if (payload.event.type === "interaction_request") {
    return withSession(state, payload.sessionId, {
      ...previous,
      pendingInteractions: dedupeInteractions([...previous.pendingInteractions, payload.event.payload])
    });
  }

  if (payload.event.type === "session_state") {
    return withSession(state, payload.sessionId, {
      ...previous,
      state: payload.event.payload
    });
  }

  return withSession(state, payload.sessionId, {
    ...previous,
    deliveries: [...previous.deliveries, payload.event.payload].slice(-20)
  });
};

export const removePendingInteraction = (
  state: MobileRelayState,
  sessionId: string,
  requestId: string
): MobileRelayState => {
  const previous = state.sessions[sessionId];
  if (!previous) return state;
  return withSession(state, sessionId, {
    ...previous,
    pendingInteractions: previous.pendingInteractions.filter((item) => item.id !== requestId)
  });
};

export const dedupeMessages = (messages: ClientMessage[]): ClientMessage[] => {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
};

export const dedupeInteractions = (interactions: InteractionRequest[]): InteractionRequest[] => {
  const seen = new Set<string>();
  return interactions.filter((interaction) => {
    if (seen.has(interaction.id)) return false;
    seen.add(interaction.id);
    return true;
  });
};

const withSession = (state: MobileRelayState, sessionId: string, session: SessionModel): MobileRelayState => ({
  sessions: {
    ...state.sessions,
    [sessionId]: session
  },
  selectedSessionId: state.selectedSessionId || sessionId
});
