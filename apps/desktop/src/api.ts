import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// The launcher's calls into the Rust side (src-tauri/src/commands.rs). Only the launcher window may make them
// (capabilities/launcher.json); panel windows loaded from a server cannot.

export type Server = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** https://… when the panel has a domain; null: reached through an SSH tunnel. */
  panelUrl: string | null;
  /** SHA-256 of the server's SSH host key, remembered on first contact. */
  hostKey: string;
  createdAt: number;
  /** "This computer": ClawDesk in Docker Desktop here, no SSH. */
  local: boolean;
};

export type AddServerInput = {
  name: string;
  host: string;
  port: number;
  user: string;
  /** One of the two: a password (used once to install the app's own key) or a private key in OpenSSH format. */
  password: string | null;
  privateKey: string | null;
  panelUrl: string | null;
};

export type InstallInput = {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  /** "domain": panelDomain; "sslip": <ip>.sslip.io; "tunnel": no HTTPS, the app's SSH tunnel only. */
  https: "domain" | "sslip" | "tunnel";
  domain: string | null;
};

export type InstallResult = { server: Server; setupUrl: string | null };
export type InstallLog = { line: string };
export type InstallStep = { step: string; index: number };
export type LocalStatus = { project: string; dataDir: string; address: string; version: string | null; running: boolean };
export type RecoveryInspection = { receipt: string; target: LocalStatus; manifest: { createdAt: string; openclawVersion: string; kind: string } };

export const api = {
  localStatus: () => invoke<LocalStatus>('local_status'),
  inspectLocalBackup: (archive: string, password: string) => invoke<RecoveryInspection>('inspect_local_backup', { archive, password }),
  restoreLocal: (receipt: string, confirmation: string, password: string) => invoke<void>('restore_local', { receipt, confirmation, password }),
  listServers: () => invoke<Server[]>("list_servers"),
  addServer: (input: AddServerInput) => invoke<Server>("add_server", { input }),
  removeServer: (id: string) => invoke<void>("remove_server", { id }),
  /** Opens the panel of this server in its own window (through the tunnel when there is no domain). */
  openPanel: (id: string, path?: string) => invoke<void>("open_panel", { id, path: path ?? null }),
  installServer: (input: InstallInput) => invoke<InstallResult>("install_server", { input }),
  /** "This computer": sets up (or updates) ClawDesk in Docker Desktop on this machine. */
  installLocal: (name: string) => invoke<InstallResult>("install_local", { name }),
  onInstallLog: (cb: (e: InstallLog) => void): Promise<UnlistenFn> => listen<InstallLog>("install://log", (e) => cb(e.payload)),
  onInstallStep: (cb: (e: InstallStep) => void): Promise<UnlistenFn> => listen<InstallStep>("install://step", (e) => cb(e.payload)),
};

export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error);
}
