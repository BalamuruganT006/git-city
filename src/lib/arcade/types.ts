// ─── Avatar config (persisted in arcade_avatars table) ────────
export interface AvatarConfig {
  sprite_id: number;
}

// ─── Directions ───────────────────────────────────────────────
export type Direction = "up" | "down" | "left" | "right";

// ─── Player state (synced via PartyKit) ───────────────────────
export interface PlayerState {
  id: string;
  github_login: string;
  avatar_url: string;
  sprite_id: number;
  x: number; // tile col
  y: number; // tile row
  dir: Direction;
}

// ─── Chat bubble (client-only, ephemeral) ─────────────────────
export interface ChatBubble {
  id: string; // player id
  text: string;
  timer: number; // seconds remaining
}

// ─── Protocol: Client → Server ────────────────────────────────
export type ClientMsg =
  | { type: "move"; dir: Direction }
  | { type: "chat"; text: string }
  | { type: "sit"; x: number; y: number; dir: Direction }
  | { type: "stand" }
  | { type: "avatar"; sprite_id: number };

// ─── Protocol: Server → Client ────────────────────────────────
export type ServerMsg =
  | { type: "sync"; players: PlayerState[] }
  | { type: "join"; player: PlayerState }
  | { type: "leave"; id: string }
  | { type: "move"; id: string; x: number; y: number; dir: Direction }
  | { type: "chat"; id: string; text: string }
  | { type: "sit"; id: string; x: number; y: number; dir: Direction }
  | { type: "stand"; id: string; x: number; y: number }
  | { type: "avatar"; id: string; sprite_id: number };
