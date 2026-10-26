/**
 * LiveKit access for one call: a fresh room, the participant's token for it, and the desk
 * agent dispatched into it.
 *
 * The browser can decode its token (it is a JWT), so the dispatch metadata carries ONLY the
 * opaque call token. The agent swaps that for the call's voice cell over the private API
 * (`study/agent-api.ts`); nothing the browser holds names a system or a voice.
 *
 * Each attempt (a first try, or a retry after a drop) gets its own room, so a retry starts a
 * clean session and the agent's `connected` report counts it as another attempt.
 */
import { randomUUID } from "node:crypto";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

/** The agent name `agent/src/agent.py` registers with. */
export const AGENT_NAME = "harborlight-desk";

/** How long a call token can be used to join; calls are a few minutes long. */
const TOKEN_TTL = "15m";

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** The three LiveKit settings, or `undefined` when calls are not configured. */
export function liveKitConfigFromEnv(env: Record<string, string | undefined>): LiveKitConfig | undefined {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return undefined;
  return { url, apiKey, apiSecret };
}

export interface CallAccess {
  /** The LiveKit server the browser connects to. */
  url: string;
  token: string;
  room: string;
}

/** Mint a participant token for a new room with the desk agent dispatched into it. */
export async function callAccess(
  config: LiveKitConfig,
  participant: string,
  callToken: string,
): Promise<CallAccess> {
  const room = `call-${randomUUID()}`;
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `p-${participant}-${randomUUID().slice(0, 8)}`,
    ttl: TOKEN_TTL,
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: callToken })],
  });
  return { url: config.url, token: await at.toJwt(), room };
}
