import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { generateUuidFromGlobalCrypto } from "@/utils/client-id";

export type SidebarGroupMode = "project" | "status";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 6;

/**
 * The key standing for "this workspace carries no labels at all".
 *
 * `normalizeWorkspaceLabelName` trims, so no real label can ever normalize to the empty string
 * and nothing in `labels` can collide with it. That is the whole reason the empty string is the
 * choice: a sentinel like `"__unlabelled__"` would be a name a person is free to type.
 */
export const SIDEBAR_UNLABELLED_LABEL_KEY = "";

/**
 * What the sidebar's Labels page currently says.
 *
 * The labels pinned to, keyed by `workspaceLabelKey`, exactly as `hostFilters` holds server ids:
 * empty means "every label", non-empty includes workspaces carrying any selected label.
 */
export interface SidebarLabelFilter {
  labels: string[];
}

export function hasActiveSidebarLabelFilter(filter: SidebarLabelFilter): boolean {
  return filter.labels.length > 0;
}

interface SidebarFilters {
  hostFilters: string[];
  projectFilters: string[];
  labelFilter: SidebarLabelFilter;
}

/**
 * A named set of the sidebar's filters.
 *
 * While a view is active, every filter change writes through to it, so the view is always what
 * the sidebar is showing and there is no separate "save changes" step to forget.
 */
export interface SidebarSavedView extends SidebarFilters {
  id: string;
  name: string;
}

export function normalizeSidebarViewName(name: string): string {
  return name.trim();
}

const NO_FILTERS: SidebarFilters = {
  hostFilters: [],
  projectFilters: [],
  labelFilter: { labels: [] },
};

function pickFilters(state: SidebarFilters): SidebarFilters {
  return {
    hostFilters: state.hostFilters,
    projectFilters: state.projectFilters,
    labelFilter: state.labelFilter,
  };
}

/** Applies a filter change and copies the result into the active view, if there is one. */
function withFilters(
  state: SidebarViewStoreState,
  patch: Partial<SidebarFilters>,
): Partial<SidebarViewStoreState> {
  if (state.activeViewId === null) return patch;
  const filters = pickFilters({ ...state, ...patch });
  return {
    ...patch,
    savedViews: state.savedViews.map((view) =>
      view.id === state.activeViewId ? { ...view, ...filters } : view,
    ),
  };
}

/**
 * Include/exclude toggle over an allowlist, shared by the host and project filters.
 *
 * Both filters answer the same question — "is this one of the things I pinned the sidebar to" —
 * so they share the operation. The label filter does not: its keys go through
 * `workspaceLabelKey` first, which is a different identity.
 */
function toggleFilterEntry(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key];
}

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  // Empty means "all hosts". A non-empty list pins the sidebar to those hosts.
  hostFilters: string[];
  /**
   * Empty means "all projects". A non-empty list is an allowlist over
   * `SidebarProjectEntry.viewKey` — the same key the project sections are built from.
   *
   * There is deliberately no `reconcileProjectFilters` counterpart to `reconcileHostFilters`.
   * The project list is narrowed by the host filter and is empty before any host connects, so
   * reconciling against it would silently destroy the filter on every cold start and every
   * host-filter change. Stale keys are resolved away at read time instead — see
   * `resolveActiveProjectFilters`.
   */
  projectFilters: string[];
  labelFilter: SidebarLabelFilter;
  savedViews: SidebarSavedView[];
  /** The view the filters write through to. `null` is the unnamed, ad-hoc filter. */
  activeViewId: string | null;
  setGroupMode: (mode: SidebarGroupMode) => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  toggleProjectFilter: (viewKey: string) => void;
  clearProjectFilters: () => void;
  toggleLabelFilter: (name: string) => void;
  clearLabelFilter: () => void;
  reconcileLabelFilter: (labels: readonly string[]) => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
  /** Saves the current filters under `name` and makes the new view active. */
  saveView: (name: string) => void;
  /** Loads a view's filters, or with `null` leaves the active view and clears every filter. */
  selectView: (id: string | null) => void;
  renameView: (id: string, name: string) => void;
  deleteView: (id: string) => void;
}

interface SidebarViewPersistedState {
  groupMode: SidebarGroupMode;
  hostFilters: string[];
  projectFilters: string[];
  labelFilter: SidebarLabelFilter;
  savedViews: SidebarSavedView[];
  activeViewId: string | null;
}

const PersistedSidebarGroupModeSchema = z.enum(["project", "status", "label"]);
const SidebarLabelFilterSchema = z.object({
  labels: z.array(z.string()),
});
const SidebarSavedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostFilters: z.array(z.string()),
  projectFilters: z.array(z.string()),
  labelFilter: SidebarLabelFilterSchema,
});
const SidebarViewPersistedStateSchema = z.strictObject({
  groupMode: PersistedSidebarGroupModeSchema.optional(),
  hostFilters: z.array(z.string()).optional(),
  hostFilter: z.string().nullable().optional(),
  projectFilters: z.array(z.string()).optional(),
  groupModeByServerId: z.record(z.string(), PersistedSidebarGroupModeSchema).optional(),
  labelFilter: SidebarLabelFilterSchema.optional(),
  savedViews: z.array(SidebarSavedViewSchema).optional(),
  activeViewId: z.string().nullable().optional(),
});

type SidebarViewStorageState = z.infer<typeof SidebarViewPersistedStateSchema>;

function readLegacyGroupMode(persistedState: SidebarViewStorageState): SidebarGroupMode | null {
  const groupModeByServerId = persistedState.groupModeByServerId;
  if (!groupModeByServerId) {
    return null;
  }

  const modes = Object.values(groupModeByServerId);
  if (modes.length === 0) return null;
  return modes.includes("status") ? "status" : "project";
}

// Reads the host filter from any persisted shape: the current `hostFilters` array, or the
// pre-v2 single `hostFilter` string (null/absent meant "all hosts").
function readHostFilters(persistedState: SidebarViewStorageState): string[] {
  const hostFilters = persistedState.hostFilters;
  if (hostFilters) {
    return hostFilters;
  }
  // COMPAT(sidebarHostFilters): added in v0.1.102, remove after 2026-12-30 once pre-v2 persisted
  // sidebar state (a single `hostFilter` string) has aged out.
  const legacyHostFilter = persistedState.hostFilter;
  return legacyHostFilter ? [legacyHostFilter] : [];
}

export function migrateSidebarViewState(persistedState: unknown): SidebarViewPersistedState {
  const result = SidebarViewPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return {
      groupMode: "project",
      hostFilters: [],
      projectFilters: [],
      labelFilter: emptyLabelFilter(),
      savedViews: [],
      activeViewId: null,
    };
  }
  const state = result.data;

  const legacyGroupMode = readLegacyGroupMode(state);
  if (legacyGroupMode) {
    return {
      groupMode: legacyGroupMode,
      hostFilters: [],
      projectFilters: [],
      labelFilter: emptyLabelFilter(),
      savedViews: [],
      activeViewId: null,
    };
  }

  const savedViews = (state.savedViews ?? []).map(
    (view): SidebarSavedView => ({
      id: view.id,
      name: view.name,
      hostFilters: view.hostFilters,
      projectFilters: view.projectFilters,
      labelFilter: normalizeSidebarLabelFilter(view.labelFilter),
    }),
  );
  const activeViewId = savedViews.some((view) => view.id === state.activeViewId)
    ? (state.activeViewId ?? null)
    : null;

  return {
    groupMode: state.groupMode === "status" ? "status" : "project",
    hostFilters: readHostFilters(state),
    projectFilters: state.projectFilters ?? [],
    labelFilter: state.labelFilter
      ? normalizeSidebarLabelFilter(state.labelFilter)
      : emptyLabelFilter(),
    savedViews,
    activeViewId,
  };
}

/**
 * Re-keys a persisted filter through `workspaceLabelKey`, so the invariant on `labels` holds for
 * state that was written by an older build of this page rather than by the current one.
 */
function normalizeSidebarLabelFilter(filter: SidebarLabelFilter): SidebarLabelFilter {
  const labels = new Set(filter.labels.map(workspaceLabelKey));
  return { labels: [...labels] };
}

export function createSidebarViewStorage(
  backingStorage: StateStorage = AsyncStorage,
): StateStorage {
  return {
    getItem: async (name) => {
      const value = await backingStorage.getItem(name);
      if (value !== null || name !== SIDEBAR_VIEW_STORAGE_KEY) {
        return value;
      }
      return backingStorage.getItem(LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY);
    },
    setItem: (name, value) => backingStorage.setItem(name, value),
    removeItem: (name) => backingStorage.removeItem(name),
  };
}

export const useSidebarViewStore = create<SidebarViewStoreState>()(
  persist(
    (set) => ({
      groupMode: "project",
      hostFilters: [],
      projectFilters: [],
      labelFilter: emptyLabelFilter(),
      savedViews: [],
      activeViewId: null,
      setGroupMode: (mode) => set({ groupMode: mode }),
      toggleHostFilter: (serverId) =>
        set((state) =>
          withFilters(state, { hostFilters: toggleFilterEntry(state.hostFilters, serverId) }),
        ),
      clearHostFilters: () => set((state) => withFilters(state, { hostFilters: [] })),
      toggleProjectFilter: (viewKey) =>
        set((state) =>
          withFilters(state, {
            projectFilters: toggleFilterEntry(state.projectFilters, viewKey),
          }),
        ),
      clearProjectFilters: () => set((state) => withFilters(state, { projectFilters: [] })),
      toggleLabelFilter: (name) =>
        set((state) => {
          const key = workspaceLabelKey(name);
          const labels = state.labelFilter.labels.includes(key)
            ? state.labelFilter.labels.filter((label) => label !== key)
            : [...state.labelFilter.labels, key];
          return withFilters(state, { labelFilter: { ...state.labelFilter, labels } });
        }),
      clearLabelFilter: () =>
        set((state) => withFilters(state, { labelFilter: emptyLabelFilter() })),
      reconcileLabelFilter: (labels) =>
        set((state) => {
          const available = new Set(labels.map(workspaceLabelKey));
          const next = state.labelFilter.labels.filter(
            (label) => label === SIDEBAR_UNLABELLED_LABEL_KEY || available.has(label),
          );
          if (next.length === state.labelFilter.labels.length) return state;
          return withFilters(state, { labelFilter: { labels: next } });
        }),
      reconcileHostFilters: (serverIds) =>
        set((state) => {
          if (state.hostFilters.length === 0) {
            return state;
          }
          const allowed = new Set(serverIds);
          const next = state.hostFilters.filter((id) => allowed.has(id));
          if (next.length === state.hostFilters.length) {
            return state;
          }
          return withFilters(state, { hostFilters: next });
        }),
      saveView: (name) =>
        set((state) => {
          const normalized = normalizeSidebarViewName(name);
          if (!normalized) return state;
          const view: SidebarSavedView = {
            id: generateUuidFromGlobalCrypto(),
            name: normalized,
            ...pickFilters(state),
          };
          return { savedViews: [...state.savedViews, view], activeViewId: view.id };
        }),
      selectView: (id) =>
        set((state) => {
          const view = id === null ? null : state.savedViews.find((entry) => entry.id === id);
          if (!view) return { activeViewId: null, ...NO_FILTERS };
          return { activeViewId: view.id, ...pickFilters(view) };
        }),
      renameView: (id, name) =>
        set((state) => {
          const normalized = normalizeSidebarViewName(name);
          if (!normalized) return state;
          return {
            savedViews: state.savedViews.map((view) =>
              view.id === id ? { ...view, name: normalized } : view,
            ),
          };
        }),
      deleteView: (id) =>
        set((state) => ({
          savedViews: state.savedViews.filter((view) => view.id !== id),
          ...(state.activeViewId === id ? { activeViewId: null, ...NO_FILTERS } : {}),
        })),
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      version: SIDEBAR_VIEW_STORE_VERSION,
      storage: createValidatedPersistStorage(
        createSidebarViewStorage(),
        SidebarViewPersistedStateSchema,
      ),
      partialize: (state) => ({
        groupMode: state.groupMode,
        hostFilters: state.hostFilters,
        projectFilters: state.projectFilters,
        labelFilter: state.labelFilter,
        savedViews: state.savedViews,
        activeViewId: state.activeViewId,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);

function emptyLabelFilter(): SidebarLabelFilter {
  return { labels: [] };
}
