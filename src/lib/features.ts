// Feature switches for whole tabs. A disabled feature keeps its code and data
// but is not mounted, so none of its background work (e.g. Maestro) runs.

// The Orchestra kanban board, Maestro, and the agent/skill builders. Paused
// 2026-10-27: unused, and the most Claude-locked part of the app. The API
// server refuses its routes too unless AIOS_ENABLE_KANBAN=1 (see api-server.cjs).
export const KANBAN_ENABLED = false;
