/**
 * One call, over LiveKit: the hook `client.tsx`'s call screen uses.
 *
 * The page asks the server for a room for this call (`POST /api/calls/connect`), joins it
 * with the microphone on, and plays whatever the desk agent says. The server dispatched the
 * agent into the room with only the call's opaque token, so nothing here (the URL, the token,
 * the room) names the system or the voice.
 *
 * A call ends three ways, and the hook reports the one it sees:
 * - the caller hangs up (`end()`), which is not a drop;
 * - the room or the agent goes away first, or no agent arrives within
 *   {@link AGENT_JOIN_TIMEOUT_MS}: a DROP, which the page offers to retry or skip;
 * - connecting fails outright (no microphone, the server refused): also a drop, with why.
 */
import {
  type Participant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { useEffect, useRef, useState } from "react";

/** How long to wait for the desk agent to join before calling it a dropped call. */
const AGENT_JOIN_TIMEOUT_MS = 20_000;

/** The attribute LiveKit agents publish their state in. */
const AGENT_STATE_ATTRIBUTE = "lk.agent.state";

/** What the call screen shows. */
export type CallState = "connecting" | "waiting" | "listening" | "thinking" | "speaking";

interface CallAccess {
  url: string;
  token: string;
}

async function connectInfo(participant: string, call: string): Promise<CallAccess> {
  const response = await fetch("/api/calls/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participant, call }),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<CallAccess> & { error?: string };
  if (!response.ok || !payload.url || !payload.token) {
    throw new Error(payload.error ?? `the server answered ${response.status}`);
  }
  return { url: payload.url, token: payload.token };
}

function agentState(participant: Participant): CallState {
  const state = participant.attributes[AGENT_STATE_ATTRIBUTE];
  return state === "speaking" || state === "thinking" || state === "listening" ? state : "waiting";
}

export interface LiveCall {
  state: CallState;
  /** The browser blocked autoplay: a tap on {@link resumeAudio} lets the desk be heard. */
  audioBlocked: boolean;
  resumeAudio: () => void;
  /** Hang up. Safe to call more than once. */
  end: () => void;
}

/**
 * Join the call on mount, leave it on unmount. `onDropped` fires at most once, with a
 * reason, when the call ends any way other than `end()`.
 */
export function useLiveCall(participant: string, call: string, onDropped: (why: string) => void): LiveCall {
  const [state, setState] = useState<CallState>("connecting");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const room = useRef<Room | null>(null);
  // The caller hung up: what follows (the room disconnecting) is not a drop.
  const hungUp = useRef(false);
  const dropped = useRef(onDropped);
  dropped.current = onDropped;

  useEffect(() => {
    const current = new Room();
    room.current = current;
    const audio: HTMLMediaElement[] = [];
    let agentTimer: ReturnType<typeof setTimeout> | undefined;
    let over = false;

    // Tear the call down once; report a drop only if the caller didn't hang up.
    const finish = (why?: string) => {
      if (over) return;
      over = true;
      if (agentTimer) clearTimeout(agentTimer);
      for (const el of audio) el.remove();
      void current.disconnect();
      if (why !== undefined && !hungUp.current) dropped.current(why);
    };

    const agentArrived = (participantNow: Participant) => {
      if (agentTimer) clearTimeout(agentTimer);
      setState(agentState(participantNow));
    };

    current
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        audio.push(el);
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        if (p.isAgent) agentArrived(p);
      })
      .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
        if (p.isAgent) setState(agentState(p));
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.isAgent) finish("the desk hung up unexpectedly");
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!current.canPlaybackAudio))
      .on(RoomEvent.Disconnected, () => finish("the connection was lost"));

    (async () => {
      try {
        const access = await connectInfo(participant, call);
        if (over) return;
        await current.connect(access.url, access.token);
        await current.localParticipant.setMicrophoneEnabled(true);
        await current.startAudio().catch(() => setAudioBlocked(true));
        const agent = [...current.remoteParticipants.values()].find((p) => p.isAgent);
        if (agent) agentArrived(agent);
        else {
          setState("waiting");
          agentTimer = setTimeout(() => finish("the desk didn't answer"), AGENT_JOIN_TIMEOUT_MS);
        }
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
      }
    })();

    // Leaving the screen any other way hangs up, and is not a drop.
    return () => finish();
  }, [participant, call]);

  return {
    state,
    audioBlocked,
    resumeAudio: () => {
      void room.current?.startAudio().then(() => setAudioBlocked(false));
    },
    end: () => {
      hungUp.current = true;
      void room.current?.disconnect();
    },
  };
}
