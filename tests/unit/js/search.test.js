/**
 * Unit tests for search.js module
 */

import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";

import {
  clearSearch,
  serverSideToolSearch,
  serverSidePromptSearch,
  serverSideResourceSearch,
  serverSideEditToolSearch,
  serverSideEditPromptsSearch,
  serverSideEditResourcesSearch,
  getPanelSearchConfig,
  getPanelSearchStateFromUrl,
  updatePanelSearchStateInUrl,
  getPanelPerPage,
  loadSearchablePanel,
  queueSearchablePanelReload,
  renderGlobalSearchMessage,
  renderGlobalSearchResults,
  runGlobalSearch,
  openGlobalSearchModal,
  closeGlobalSearchModal,
  navigateToGlobalSearchResult,
  ensureNoResultsElement,
  captureNonMemberSelections,
  restoreNonMemberSelections,
  captureMemberOverrides,
  restoreMemberOverrides,
  debouncedMemberSearch,
  debouncedNonMemberSearch,
  serverSideMemberSearch,
  serverSideNonMemberSearch,
} from "../../../mcpgateway/admin_ui/search.js";

// Mock dependencies
vi.mock("../../../mcpgateway/admin_ui/utils.js", () => ({
  safeGetElement: vi.fn((id) => document.getElementById(id)),
  getCookie: vi.fn(() => "mock-token"),
  getCurrentTeamId: vi.fn(() => null),
  isAdminUser: vi.fn(() => false),
  fetchWithAuth: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/tokens.js", () => ({
  fetchWithAuth: vi.fn(() => Promise.resolve({ ok: false })),
  performTokenSearch: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/security.js", () => ({
  escapeHtml: vi.fn((str) => String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m])),
  safeReplaceState: vi.fn((state, title, url) => {
    window.history.replaceState(state, title, url);
  }),
}));

vi.mock("../../../mcpgateway/admin_ui/tabs.js", () => ({
  getUiHiddenSections: vi.fn(() => new Set()),
  showTab: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/filters.js", () => ({
  filterServerTable: vi.fn(),
  filterToolsTable: vi.fn(),
  filterResourcesTable: vi.fn(),
  filterPromptsTable: vi.fn(),
  filterGatewaysTable: vi.fn(),
  filterA2AAgentsTable: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/gateway.js", () => ({
  getSelectedGatewayIds: vi.fn(() => []),
}));

vi.mock("../../../mcpgateway/admin_ui/servers.js", () => ({
  getEditSelections: vi.fn(() => new Set()),
  updateToolMapping: vi.fn(),
  updatePromptMapping: vi.fn(),
  updateResourceMapping: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/tools.js", () => ({
  initToolSelect: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/prompts.js", () => ({
  initPromptSelect: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/resources.js", () => ({
  initResourceSelect: vi.fn(),
}));

vi.mock("../../../mcpgateway/admin_ui/appState.js", () => {
  const state = {
    nonMemberSelectionsCache: {},
    memberOverridesCache: {},
    memberSearchTimers: {},
    nonMemberSearchTimers: {},
  };
  return { AppState: state };
});

beforeEach(async () => {
  window.ROOT_PATH = "";
  window.htmx = {
    ajax: vi.fn(),
    process: vi.fn(),
  };
  window.Admin = {
    toolMapping: {},
    promptMapping: {},
    resourceMapping: {},
  };
  vi.clearAllMocks();

  // Reset AppState caches between tests
  const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
  AppState.nonMemberSelectionsCache = {};
  AppState.memberOverridesCache = {};
  AppState.memberSearchTimers = {};
  AppState.nonMemberSearchTimers = {};

  // Reset fetchWithAuth mock to default success
  const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({ ok: false });
});

afterEach(() => {
  document.body.innerHTML = "";
  delete window.htmx;
  delete window.Admin;
});

// Helper: build a simple table with searchable rows
function buildSearchableTable(entityType, tbodyId, rows) {
  const panel = document.createElement("div");
  panel.id = `${entityType}-panel`;

  const input = document.createElement("input");
  // Use correct ID mapping: catalog uses servers-search-input
  const inputId = entityType === "catalog" ? "servers-search-input" : `${entityType}-search-input`;
  input.id = inputId;
  input.value = "previous search";
  panel.appendChild(input);

  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  tbody.id = tbodyId;

  rows.forEach((text) => {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  panel.appendChild(table);
  document.body.appendChild(panel);
  return input;
}

// ---------------------------------------------------------------------------
// clearSearch
// ---------------------------------------------------------------------------
describe("clearSearch", () => {
  test("clears catalog search input", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = buildSearchableTable("catalog", "servers-table-body", ["Server A"]);
    clearSearch("catalog");
    expect(input.value).toBe("");
    consoleSpy.mockRestore();
  });

  test("clears tools search input", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = buildSearchableTable("tools", "tools-table-body", ["Tool A"]);
    clearSearch("tools");
    expect(input.value).toBe("");
    consoleSpy.mockRestore();
  });

  test("clears resources search input", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = buildSearchableTable("resources", "resources-table-body", ["Res A"]);
    clearSearch("resources");
    expect(input.value).toBe("");
    consoleSpy.mockRestore();
  });

  test("clears prompts search input", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = buildSearchableTable("prompts", "prompts-table-body", ["Prompt A"]);
    clearSearch("prompts");
    expect(input.value).toBe("");
    consoleSpy.mockRestore();
  });

  test("clears a2a-agents search input", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = buildSearchableTable("a2a-agents", "agents-table-body", ["Agent A"]);
    clearSearch("a2a-agents");
    expect(input.value).toBe("");
    consoleSpy.mockRestore();
  });

  test("clears gateways search input", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = buildSearchableTable("gateways", "gateways-table-body", ["GW A"]);
    clearSearch("gateways");
    expect(input.value).toBe("");
    consoleSpy.mockRestore();
  });

  test("does not throw for unknown entity type", () => {
    expect(() => clearSearch("unknown")).not.toThrow();
  });

  test("does not throw when input elements are missing", () => {
    expect(() => clearSearch("catalog")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// serverSideToolSearch
// ---------------------------------------------------------------------------
describe("serverSideToolSearch", () => {
  test("does nothing when container is missing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverSideToolSearch("test");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// serverSidePromptSearch
// ---------------------------------------------------------------------------
describe("serverSidePromptSearch", () => {
  test("does nothing when container is missing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverSidePromptSearch("test");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// serverSideResourceSearch
// ---------------------------------------------------------------------------
describe("serverSideResourceSearch", () => {
  test("does nothing when container is missing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverSideResourceSearch("test");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getPanelSearchConfig
// ---------------------------------------------------------------------------
describe("getPanelSearchConfig", () => {
  test("returns config for valid entity type", () => {
    const config = getPanelSearchConfig("catalog");
    expect(config).toBeTruthy();
    expect(config.tableName).toBe("servers");
  });

  test("returns null for invalid entity type", () => {
    const config = getPanelSearchConfig("invalid");
    expect(config).toBeNull();
  });

  test("returns config for tools", () => {
    const config = getPanelSearchConfig("tools");
    expect(config).toBeTruthy();
    expect(config.tableName).toBe("tools");
  });

  test("returns config for resources", () => {
    const config = getPanelSearchConfig("resources");
    expect(config).toBeTruthy();
    expect(config.tableName).toBe("resources");
  });

  test("returns config for prompts", () => {
    const config = getPanelSearchConfig("prompts");
    expect(config).toBeTruthy();
    expect(config.tableName).toBe("prompts");
  });
});

// ---------------------------------------------------------------------------
// getPanelSearchStateFromUrl
// ---------------------------------------------------------------------------
describe("getPanelSearchStateFromUrl", () => {
  test("extracts query and tags from URL", () => {
    window.history.replaceState({}, "", "?servers_q=test&servers_tags=tag1");
    const state = getPanelSearchStateFromUrl("servers");
    expect(state.query).toBe("test");
    expect(state.tags).toBe("tag1");
  });

  test("returns empty strings when params missing", () => {
    window.history.replaceState({}, "", "?other=value");
    const state = getPanelSearchStateFromUrl("servers");
    expect(state.query).toBe("");
    expect(state.tags).toBe("");
  });

  test("trims whitespace from values", () => {
    window.history.replaceState({}, "", "?servers_q=  test  &servers_tags=  tag1  ");
    const state = getPanelSearchStateFromUrl("servers");
    expect(state.query).toBe("test");
    expect(state.tags).toBe("tag1");
  });
});

// ---------------------------------------------------------------------------
// updatePanelSearchStateInUrl
// ---------------------------------------------------------------------------
describe("updatePanelSearchStateInUrl", () => {
  test("sets query param in URL", () => {
    updatePanelSearchStateInUrl("servers", "test", "");
    expect(window.location.search).toContain("servers_q=test");
  });

  test("sets tags param in URL", () => {
    updatePanelSearchStateInUrl("servers", "", "tag1");
    expect(window.location.search).toContain("servers_tags=tag1");
  });

  test("removes params when empty", () => {
    window.history.replaceState({}, "", "?servers_q=test&servers_tags=tag1");
    updatePanelSearchStateInUrl("servers", "", "");
    expect(window.location.search).not.toContain("servers_q");
    expect(window.location.search).not.toContain("servers_tags");
  });

  test("resets page to 1", () => {
    updatePanelSearchStateInUrl("servers", "test", "");
    expect(window.location.search).toContain("servers_page=1");
  });

  test("trims whitespace from inputs", () => {
    updatePanelSearchStateInUrl("servers", "  test  ", "  tag1  ");
    expect(window.location.search).toContain("servers_q=test");
    expect(window.location.search).toContain("servers_tags=tag1");
  });
});

// ---------------------------------------------------------------------------
// getPanelPerPage
// ---------------------------------------------------------------------------
describe("getPanelPerPage", () => {
  test("returns value from selector", () => {
    const select = document.createElement("select");
    select.id = "servers-pagination-controls";
    select.innerHTML = '<option value="25" selected>25</option>';
    
    const controls = document.createElement("div");
    controls.id = "servers-pagination-controls";
    controls.appendChild(select);
    document.body.appendChild(controls);

    const perPage = getPanelPerPage({ tableName: "servers", defaultPerPage: 10 });
    expect(perPage).toBe(25);
  });

  test("returns default when selector missing", () => {
    const perPage = getPanelPerPage({ tableName: "servers", defaultPerPage: 10 });
    expect(perPage).toBe(10);
  });

  test("returns default when value is NaN", () => {
    const select = document.createElement("select");
    select.value = "invalid";
    
    const controls = document.createElement("div");
    controls.id = "servers-pagination-controls";
    controls.appendChild(select);
    document.body.appendChild(controls);

    const perPage = getPanelPerPage({ tableName: "servers", defaultPerPage: 10 });
    expect(perPage).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// loadSearchablePanel
// ---------------------------------------------------------------------------
describe("loadSearchablePanel", () => {
  test("does nothing for invalid entity type", () => {
    loadSearchablePanel("invalid");
    expect(window.htmx.ajax).not.toHaveBeenCalled();
  });

  test("loads panel with search params", () => {
    const searchInput = document.createElement("input");
    searchInput.id = "servers-search-input";
    searchInput.value = "test";
    document.body.appendChild(searchInput);

    const tagInput = document.createElement("input");
    tagInput.id = "servers-tag-filter";
    tagInput.value = "tag1";
    document.body.appendChild(tagInput);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "show-inactive-servers";
    checkbox.checked = true;
    document.body.appendChild(checkbox);

    loadSearchablePanel("catalog");

    expect(window.htmx.ajax).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("q=test"),
      expect.any(Object)
    );
  });

  test("includes team_id when available", async () => {
    const { getCurrentTeamId } = await import("../../../mcpgateway/admin_ui/utils.js");
    getCurrentTeamId.mockReturnValue("team-123");

    const searchInput = document.createElement("input");
    searchInput.id = "servers-search-input";
    document.body.appendChild(searchInput);

    loadSearchablePanel("catalog");

    expect(window.htmx.ajax).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("team_id=team-123"),
      expect.any(Object)
    );
  });
});

// ---------------------------------------------------------------------------
// queueSearchablePanelReload
// ---------------------------------------------------------------------------
describe("queueSearchablePanelReload", () => {
  test("debounces panel reload", () => {
    vi.useFakeTimers();
    
    const searchInput = document.createElement("input");
    searchInput.id = "catalog-search-input";
    document.body.appendChild(searchInput);

    queueSearchablePanelReload("catalog", 100);
    expect(window.htmx.ajax).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(window.htmx.ajax).toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("cancels previous timer", () => {
    vi.useFakeTimers();
    
    const searchInput = document.createElement("input");
    searchInput.id = "catalog-search-input";
    document.body.appendChild(searchInput);

    queueSearchablePanelReload("catalog", 100);
    queueSearchablePanelReload("catalog", 100);
    
    vi.advanceTimersByTime(100);
    expect(window.htmx.ajax).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// renderGlobalSearchMessage
// ---------------------------------------------------------------------------
describe("renderGlobalSearchMessage", () => {
  test("renders message in container", () => {
    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    renderGlobalSearchMessage("Test message");
    expect(container.innerHTML).toContain("Test message");
  });

  test("does nothing when container missing", () => {
    expect(() => renderGlobalSearchMessage("Test")).not.toThrow();
  });

  test("escapes HTML in message", () => {
    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    renderGlobalSearchMessage("<script>alert('xss')</script>");
    expect(container.innerHTML).not.toContain("<script>");
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// renderGlobalSearchResults
// ---------------------------------------------------------------------------
describe("renderGlobalSearchResults", () => {
  test("renders results grouped by entity type", () => {
    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    const payload = {
      groups: [
        {
          entity_type: "servers",
          items: [
            { id: "s1", name: "Server 1", description: "Test server" }
          ]
        }
      ]
    };

    renderGlobalSearchResults(payload);
    expect(container.innerHTML).toContain("Server 1");
    expect(container.innerHTML).toContain("Test server");
  });

  test("shows no results message when empty", () => {
    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    renderGlobalSearchResults({ groups: [] });
    expect(container.innerHTML).toContain("No matching results");
  });

  test("filters hidden sections", async () => {
    const { getUiHiddenSections } = await import("../../../mcpgateway/admin_ui/tabs.js");
    getUiHiddenSections.mockReturnValueOnce(new Set(["servers"]));

    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    const payload = {
      groups: [
        {
          entity_type: "servers",
          items: [{ id: "s1", name: "Server 1" }]
        }
      ]
    };

    renderGlobalSearchResults(payload);
    expect(container.innerHTML).toContain("No matching results");
  });

  test("attaches click listeners to results", () => {
    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    const payload = {
      groups: [
        {
          entity_type: "servers",
          items: [{ id: "s1", name: "Server 1" }]
        }
      ]
    };

    renderGlobalSearchResults(payload);
    const button = container.querySelector('[data-action="navigate-search-result"]');
    expect(button).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// runGlobalSearch
// ---------------------------------------------------------------------------
describe("runGlobalSearch", () => {
  test("shows message for empty query", async () => {
    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    await runGlobalSearch("");
    expect(container.innerHTML).toContain("Start typing");
  });

  test("performs search with query", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [] })
    });

    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    await runGlobalSearch("test");
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("q=test")
    );
  });

  test("handles search error", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockRejectedValue(new Error("Network error"));

    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runGlobalSearch("test");
    expect(container.innerHTML).toContain("Search failed");
    consoleSpy.mockRestore();
  });

  test("ignores out-of-order responses", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    
    let resolveFirst;
    const firstPromise = new Promise(resolve => { resolveFirst = resolve; });
    
    fetchWithAuth
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ groups: [{ entity_type: "servers", items: [{ id: "s2", name: "Server 2" }] }] })
      });

    const container = document.createElement("div");
    container.id = "global-search-results";
    document.body.appendChild(container);

    const search1 = runGlobalSearch("first");
    const search2 = runGlobalSearch("second");

    await search2;
    expect(container.innerHTML).toContain("Server 2");

    resolveFirst({
      ok: true,
      json: async () => ({ groups: [{ entity_type: "servers", items: [{ id: "s1", name: "Server 1" }] }] })
    });
    await search1;

    // Should still show Server 2 (latest request)
    expect(container.innerHTML).toContain("Server 2");
    expect(container.innerHTML).not.toContain("Server 1");
  });
});

// ---------------------------------------------------------------------------
// openGlobalSearchModal
// ---------------------------------------------------------------------------
describe("openGlobalSearchModal", () => {
  test("opens modal and focuses input", () => {
    const modal = document.createElement("div");
    modal.id = "global-search-modal";
    modal.classList.add("hidden");
    document.body.appendChild(modal);

    const input = document.createElement("input");
    input.id = "global-search-input";
    modal.appendChild(input);

    const focusSpy = vi.spyOn(input, "focus");

    openGlobalSearchModal();

    expect(modal.classList.contains("hidden")).toBe(false);
    expect(modal.getAttribute("aria-hidden")).toBe("false");
    expect(focusSpy).toHaveBeenCalled();
  });

  test("triggers search when input has value", () => {
    const modal = document.createElement("div");
    modal.id = "global-search-modal";
    modal.classList.add("hidden");
    document.body.appendChild(modal);

    const input = document.createElement("input");
    input.id = "global-search-input";
    input.value = "test";
    modal.appendChild(input);

    const results = document.createElement("div");
    results.id = "global-search-results";
    modal.appendChild(results);

    openGlobalSearchModal();

    // Verify modal opened
    expect(modal.classList.contains("hidden")).toBe(false);
    
    // Verify search was triggered - results container should show "Searching..." message
    expect(results.innerHTML).toContain("Searching");
  });

  test("does nothing when elements missing", () => {
    expect(() => openGlobalSearchModal()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// closeGlobalSearchModal
// ---------------------------------------------------------------------------
describe("closeGlobalSearchModal", () => {
  test("closes modal", () => {
    const modal = document.createElement("div");
    modal.id = "global-search-modal";
    document.body.appendChild(modal);

    closeGlobalSearchModal();

    expect(modal.classList.contains("hidden")).toBe(true);
    expect(modal.getAttribute("aria-hidden")).toBe("true");
  });

  test("does nothing when modal missing", () => {
    expect(() => closeGlobalSearchModal()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// navigateToGlobalSearchResult
// ---------------------------------------------------------------------------
describe("navigateToGlobalSearchResult", () => {
  test("navigates to result", async () => {
    const { showTab } = await import("../../../mcpgateway/admin_ui/tabs.js");
    
    const button = document.createElement("button");
    button.dataset.entity = "servers";
    button.dataset.id = "s1";

    window.viewServer = vi.fn();

    navigateToGlobalSearchResult(button);

    expect(showTab).toHaveBeenCalledWith("catalog");
  });

  test("does nothing for invalid button", () => {
    expect(() => navigateToGlobalSearchResult(null)).not.toThrow();
  });

  test("does nothing when entity type missing", () => {
    const button = document.createElement("button");
    button.dataset.id = "s1";

    navigateToGlobalSearchResult(button);
  });

  test("does nothing when entity id missing", () => {
    const button = document.createElement("button");
    button.dataset.entity = "servers";

    navigateToGlobalSearchResult(button);
  });
});

// ---------------------------------------------------------------------------
// ensureNoResultsElement
// ---------------------------------------------------------------------------
describe("ensureNoResultsElement", () => {
  test("returns existing element", () => {
    const container = document.createElement("div");
    container.id = "test-container";
    document.body.appendChild(container);

    const msg = document.createElement("p");
    msg.id = "test-msg";
    const span = document.createElement("span");
    span.id = "test-span";
    msg.appendChild(span);
    document.body.appendChild(msg);

    const result = ensureNoResultsElement("test-container", "test-msg", "test-span", "item");
    expect(result.msg).toBe(msg);
    expect(result.span).toBe(span);
  });

  test("creates element when missing", () => {
    const container = document.createElement("div");
    container.id = "test-container";
    document.body.appendChild(container);

    const result = ensureNoResultsElement("test-container", "test-msg", "test-span", "item");
    expect(result.msg).toBeTruthy();
    expect(result.span).toBeTruthy();
    expect(result.msg.id).toBe("test-msg");
    expect(result.span.id).toBe("test-span");
  });

  test("returns null when container missing", () => {
    const result = ensureNoResultsElement("missing", "test-msg", "test-span", "item");
    expect(result.msg).toBeNull();
    expect(result.span).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serverSideEditToolSearch
// ---------------------------------------------------------------------------
describe("serverSideEditToolSearch", () => {
  test("does nothing when container is missing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverSideEditToolSearch("test");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// serverSideEditPromptsSearch
// ---------------------------------------------------------------------------
describe("serverSideEditPromptsSearch", () => {
  test("does nothing when container is missing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverSideEditPromptsSearch("test");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// serverSideEditResourcesSearch
// ---------------------------------------------------------------------------
describe("serverSideEditResourcesSearch", () => {
  test("does nothing when container is missing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverSideEditResourcesSearch("test");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Helper: build a team members container with user-item rows
// ---------------------------------------------------------------------------
function buildTeamMembersContainer(teamId, members = []) {
  const container = document.createElement("div");
  container.id = `team-members-container-${teamId}`;
  container.setAttribute("data-per-page", "50");
  members.forEach(({ email, role, autoCheck = false }) => {
    const item = document.createElement("div");
    item.className = "user-item";
    item.setAttribute("data-user-email", email);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "associatedUsers";
    cb.value = email;
    if (autoCheck) cb.setAttribute("data-auto-check", "true");

    const roleSelect = document.createElement("select");
    roleSelect.className = "role-select";
    // Add all possible role options
    ["member", "admin", "viewer"].forEach(r => {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      roleSelect.appendChild(opt);
    });
    roleSelect.value = role;

    item.appendChild(cb);
    item.appendChild(roleSelect);
    container.appendChild(item);
  });
  document.body.appendChild(container);
  return container;
}

function buildNonMembersContainer(teamId, members = []) {
  const container = document.createElement("div");
  container.id = `team-non-members-container-${teamId}`;
  members.forEach(({ email, role, checked = false }) => {
    const item = document.createElement("div");
    item.className = "user-item";
    item.setAttribute("data-user-email", email);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "associatedUsers";
    cb.value = email;
    cb.checked = checked;

    const roleSelect = document.createElement("select");
    roleSelect.className = "role-select";
    // Add all possible role options
    ["member", "admin", "viewer"].forEach(r => {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      roleSelect.appendChild(opt);
    });
    roleSelect.value = role;

    item.appendChild(cb);
    item.appendChild(roleSelect);
    container.appendChild(item);
  });
  document.body.appendChild(container);
  return container;
}

// ---------------------------------------------------------------------------
// captureNonMemberSelections
// ---------------------------------------------------------------------------
describe("captureNonMemberSelections", () => {
  test("does nothing when container is missing", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    captureNonMemberSelections("team-99");
    expect(AppState.nonMemberSelectionsCache["team-99"]).toBeUndefined();
  });

  test("captures checked non-members into cache", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    buildNonMembersContainer("team-1", [
      { email: "alice@example.com", role: "member", checked: true },
      { email: "bob@example.com", role: "admin", checked: false },
    ]);

    captureNonMemberSelections("team-1");

    expect(AppState.nonMemberSelectionsCache["team-1"]["alice@example.com"]).toBe("member");
    expect(AppState.nonMemberSelectionsCache["team-1"]["bob@example.com"]).toBeUndefined();
  });

  test("removes unchecked entries from existing cache", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.nonMemberSelectionsCache["team-2"] = { "alice@example.com": "member" };
    buildNonMembersContainer("team-2", [
      { email: "alice@example.com", role: "member", checked: false },
    ]);

    captureNonMemberSelections("team-2");

    expect(AppState.nonMemberSelectionsCache["team-2"]["alice@example.com"]).toBeUndefined();
  });

  test("skips items without email attribute", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    const container = document.createElement("div");
    container.id = "team-non-members-container-team-3";
    const item = document.createElement("div");
    item.className = "user-item";
    // No data-user-email attribute
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "associatedUsers";
    cb.checked = true;
    item.appendChild(cb);
    container.appendChild(item);
    document.body.appendChild(container);

    captureNonMemberSelections("team-3");

    expect(AppState.nonMemberSelectionsCache["team-3"]).toEqual({});
  });

  test("does not capture auto-checked items", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    const container = document.createElement("div");
    container.id = "team-non-members-container-team-4";
    const item = document.createElement("div");
    item.className = "user-item";
    item.setAttribute("data-user-email", "carol@example.com");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "associatedUsers";
    cb.checked = true;
    cb.setAttribute("data-auto-check", "true");
    item.appendChild(cb);
    container.appendChild(item);
    document.body.appendChild(container);

    captureNonMemberSelections("team-4");

    expect(AppState.nonMemberSelectionsCache["team-4"]["carol@example.com"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// restoreNonMemberSelections
// ---------------------------------------------------------------------------
describe("restoreNonMemberSelections", () => {
  test("does nothing when container is missing", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.nonMemberSelectionsCache["team-10"] = { "alice@example.com": "member" };
    // No container in DOM — should not throw
    expect(() => restoreNonMemberSelections("team-10")).not.toThrow();
  });

  test("does nothing when cache is missing for team", async () => {
    buildNonMembersContainer("team-11", [
      { email: "alice@example.com", role: "member", checked: false },
    ]);
    expect(() => restoreNonMemberSelections("team-11")).not.toThrow();
  });

  test("restores checked state for cached user visible in DOM", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.nonMemberSelectionsCache["team-12"] = { "alice@example.com": "admin" };
    buildNonMembersContainer("team-12", [
      { email: "alice@example.com", role: "member", checked: false },
    ]);

    restoreNonMemberSelections("team-12");

    const container = document.getElementById("team-non-members-container-team-12");
    const cb = container.querySelector('input[name="associatedUsers"]');
    const roleSelect = container.querySelector(".role-select");
    expect(cb.checked).toBe(true);
    expect(roleSelect.value).toBe("admin");
  });

  test("injects hidden cached-selection element for off-screen cached user", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.nonMemberSelectionsCache["team-13"] = { "ghost@example.com": "viewer" };
    buildNonMembersContainer("team-13", []);

    restoreNonMemberSelections("team-13");

    const container = document.getElementById("team-non-members-container-team-13");
    const hiddenDiv = container.querySelector(".cached-selection");
    expect(hiddenDiv).toBeTruthy();
    const hiddenCb = hiddenDiv.querySelector('input[name="associatedUsers"]');
    expect(hiddenCb.value).toBe("ghost@example.com");
    expect(hiddenCb.checked).toBe(true);
  });

  test("removes stale cached-selection elements before re-injecting", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.nonMemberSelectionsCache["team-14"] = { "ghost@example.com": "member" };
    const container = buildNonMembersContainer("team-14", []);
    // Pre-populate a stale cached-selection
    const stale = document.createElement("div");
    stale.className = "cached-selection hidden";
    container.appendChild(stale);

    restoreNonMemberSelections("team-14");

    const allCached = container.querySelectorAll(".cached-selection");
    expect(allCached.length).toBe(1); // Only the freshly created one
  });
});

// ---------------------------------------------------------------------------
// captureMemberOverrides
// ---------------------------------------------------------------------------
describe("captureMemberOverrides", () => {
  test("does nothing when container is missing", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    captureMemberOverrides("team-20");
    expect(AppState.memberOverridesCache["team-20"]).toBeUndefined();
  });

  test("captures override when auto-check member is unchecked", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    const container = buildTeamMembersContainer("team-21", [
      { email: "alice@example.com", role: "member", autoCheck: true },
    ]);
    // Uncheck the auto-checked member
    const cb = container.querySelector('input[name="associatedUsers"]');
    cb.checked = false;

    captureMemberOverrides("team-21");

    expect(AppState.memberOverridesCache["team-21"]["alice@example.com"]).toEqual({
      checked: false,
      role: "member",
    });
  });

  test("does not capture non-auto-check members", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    buildTeamMembersContainer("team-22", [
      { email: "bob@example.com", role: "admin", autoCheck: false },
    ]);
    const container = document.getElementById("team-members-container-team-22");
    const cb = container.querySelector('input[name="associatedUsers"]');
    cb.checked = false;

    captureMemberOverrides("team-22");

    expect(AppState.memberOverridesCache["team-22"] ?? {}).toEqual({});
  });

  test("skips items without email attribute", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    const container = document.createElement("div");
    container.id = "team-members-container-team-23";
    const item = document.createElement("div");
    item.className = "user-item";
    // No data-user-email
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "associatedUsers";
    cb.checked = false;
    cb.setAttribute("data-auto-check", "true");
    item.appendChild(cb);
    container.appendChild(item);
    document.body.appendChild(container);

    captureMemberOverrides("team-23");

    expect(AppState.memberOverridesCache["team-23"]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// restoreMemberOverrides
// ---------------------------------------------------------------------------
describe("restoreMemberOverrides", () => {
  test("does nothing when container is missing", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.memberOverridesCache["team-30"] = { "alice@example.com": { checked: false, role: "admin" } };
    expect(() => restoreMemberOverrides("team-30")).not.toThrow();
  });

  test("does nothing when cache is missing for team", () => {
    buildTeamMembersContainer("team-31", [
      { email: "alice@example.com", role: "member" },
    ]);
    expect(() => restoreMemberOverrides("team-31")).not.toThrow();
  });

  test("restores checked and role from cache", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.memberOverridesCache["team-32"] = {
      "alice@example.com": { checked: false, role: "viewer" },
    };
    buildTeamMembersContainer("team-32", [
      { email: "alice@example.com", role: "member" },
    ]);
    const container = document.getElementById("team-members-container-team-32");
    const cb = container.querySelector('input[name="associatedUsers"]');
    cb.checked = true; // start checked, cache says false

    restoreMemberOverrides("team-32");

    expect(cb.checked).toBe(false);
    const roleSelect = container.querySelector(".role-select");
    expect(roleSelect.value).toBe("viewer");
  });

  test("skips members not present in cache", async () => {
    const { AppState } = await import("../../../mcpgateway/admin_ui/appState.js");
    AppState.memberOverridesCache["team-33"] = {};
    buildTeamMembersContainer("team-33", [
      { email: "bob@example.com", role: "member" },
    ]);
    const container = document.getElementById("team-members-container-team-33");
    const cb = container.querySelector('input[name="associatedUsers"]');
    cb.checked = true;

    restoreMemberOverrides("team-33");

    // Should remain unchanged
    expect(cb.checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// debouncedMemberSearch
// ---------------------------------------------------------------------------
describe("debouncedMemberSearch", () => {
  test("calls serverSideMemberSearch after delay", async () => {
    vi.useFakeTimers();
    buildTeamMembersContainer("team-40", []);

    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      text: async () => "<div>members</div>",
    });

    debouncedMemberSearch("team-40", "alice", 200);
    expect(fetchWithAuth).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("team-40/members/partial")
    );

    vi.useRealTimers();
  });

  test("debounces rapid calls — only fires once", async () => {
    vi.useFakeTimers();
    buildTeamMembersContainer("team-41", []);

    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      text: async () => "<div>members</div>",
    });

    debouncedMemberSearch("team-41", "a", 200);
    debouncedMemberSearch("team-41", "al", 200);
    debouncedMemberSearch("team-41", "ali", 200);

    await vi.runAllTimersAsync();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("search=ali")
    );

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// debouncedNonMemberSearch
// ---------------------------------------------------------------------------
describe("debouncedNonMemberSearch", () => {
  test("calls serverSideNonMemberSearch after delay", async () => {
    vi.useFakeTimers();
    buildNonMembersContainer("team-50", []);

    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      text: async () => "<div>users</div>",
    });

    debouncedNonMemberSearch("team-50", "alice", 200);
    expect(fetchWithAuth).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("team-50/non-members/partial")
    );

    vi.useRealTimers();
  });

  test("debounces rapid calls — only fires once", async () => {
    vi.useFakeTimers();
    buildNonMembersContainer("team-51", []);

    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      text: async () => "<div>users</div>",
    });

    debouncedNonMemberSearch("team-51", "ali", 200);
    debouncedNonMemberSearch("team-51", "alic", 200);
    debouncedNonMemberSearch("team-51", "alice", 200);

    await vi.runAllTimersAsync();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("search=alice")
    );

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// serverSideMemberSearch
// ---------------------------------------------------------------------------
describe("serverSideMemberSearch", () => {
  test("does nothing when container is missing", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    await serverSideMemberSearch("team-60", "alice");
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test("fetches and renders member list", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    fetchWithAuth.mockReset();
    fetchWithAuth.mockImplementation(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve("<div>member-html</div>"),
    }));
    buildTeamMembersContainer("team-61", []);

    await serverSideMemberSearch("team-61", "alice");

    const container = document.getElementById("team-members-container-team-61");
    expect(container.innerHTML).toContain("member-html");
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("team-61/members/partial")
    );
    
    consoleSpy.mockRestore();
  });

  test("includes search param when searchTerm is non-empty", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    buildTeamMembersContainer("team-62", []);

    await serverSideMemberSearch("team-62", "bob");

    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("search=bob")
    );
  });

  test("omits search param when searchTerm is blank", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    buildTeamMembersContainer("team-63", []);

    await serverSideMemberSearch("team-63", "");

    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.not.stringContaining("search=")
    );
  });

  test("shows error message on fetch failure", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockRejectedValue(new Error("Network error"));
    buildTeamMembersContainer("team-64", []);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await serverSideMemberSearch("team-64", "alice");

    const container = document.getElementById("team-members-container-team-64");
    expect(container.innerHTML).toContain("Error searching members");
    consoleSpy.mockRestore();
  });

  test("uses data-per-page attribute from container when available", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    const container = buildTeamMembersContainer("team-65", []);
    container.setAttribute("data-per-page", "25");

    await serverSideMemberSearch("team-65", "");

    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("per_page=25")
    );
  });
});

// ---------------------------------------------------------------------------
// serverSideNonMemberSearch
// ---------------------------------------------------------------------------
describe("serverSideNonMemberSearch", () => {
  test("does nothing when container is missing", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    await serverSideNonMemberSearch("team-70", "alice");
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test("shows minimum-chars message when searchTerm is too short", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    buildNonMembersContainer("team-71", []);

    await serverSideNonMemberSearch("team-71", "a");

    const container = document.getElementById("team-non-members-container-team-71");
    expect(container.innerHTML).toContain("2 characters");
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test("shows minimum-chars message when searchTerm is empty", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    buildNonMembersContainer("team-72", []);

    await serverSideNonMemberSearch("team-72", "");

    const container = document.getElementById("team-non-members-container-team-72");
    expect(container.innerHTML).toContain("2 characters");
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test("fetches and renders non-member list for valid search term", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockReset();
    fetchWithAuth.mockImplementation(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve("<div>non-member-html</div>"),
    }));
    buildNonMembersContainer("team-73", []);

    await serverSideNonMemberSearch("team-73", "alice");

    const container = document.getElementById("team-non-members-container-team-73");
    expect(container.innerHTML).toContain("non-member-html");
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("team-73/non-members/partial")
    );
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("search=alice")
    );
  });

  test("shows error message on fetch failure", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    fetchWithAuth.mockRejectedValue(new Error("Network error"));
    buildNonMembersContainer("team-74", []);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await serverSideNonMemberSearch("team-74", "alice");

    const container = document.getElementById("team-non-members-container-team-74");
    expect(container.innerHTML).toContain("Error searching users");
    consoleSpy.mockRestore();
  });

  test("trims searchTerm before minimum-length check", async () => {
    const { fetchWithAuth } = await import("../../../mcpgateway/admin_ui/tokens.js");
    buildNonMembersContainer("team-75", []);

    // Single char with surrounding spaces trims to 1 char — below threshold
    await serverSideNonMemberSearch("team-75", "  a  ");

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
