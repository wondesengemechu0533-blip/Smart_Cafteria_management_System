/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/utils/searchable-dropdown.js
 *
 * Reusable searchable choice dropdown for the Ethiopian delivery location
 * system (City -> Area / Subcity / Kebele -> Street / Area Name -> Landmark).
 *
 * Click the field -> a panel opens with a search box and a choice list ->
 * pick a choice (or "Other / Enter manually") -> the value appears in the
 * field. Nothing here ever forces a selection: free text is always accepted
 * through the "Use ..." row, and the caller stays the source of truth via
 * onChange().
 *
 * Dependency-free (no framework, no imports) so any page can use it:
 *
 *   import { createSearchableDropdown } from "./utils/searchable-dropdown.js";
 *   const dd = createSearchableDropdown({
 *     container: document.getElementById("delivery-city-dropdown"),
 *     placeholder: () => ct("delivery_dd_select_city", "Select city"),
 *     searchPlaceholder: () => ct("delivery_dd_search_cities", "Search cities..."),
 *     initialOptions: [{ group: "Addis Ababa", items: [{ value: "Addis Ababa", label: "Addis Ababa" }] }],
 *     onChange: (value, meta) => { hiddenInput.value = value; },
 *   });
 *   dd.setOptions([...]);      // replace the choice list (e.g. city changed)
 *   dd.setValue("Bole");       // programmatic select (must exist in options)
 *   dd.setCustomValue("Kebele 12"); // programmatic free-text value
 *   dd.clear();                // empty the field
 *   dd.refresh();              // re-resolve labels (e.g. after language change)
 */

var openDropdown = null;

function closeOpenDropdown() {
  if (openDropdown && typeof openDropdown.close === "function") {
    openDropdown.close();
  }
  openDropdown = null;
}

if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", function (event) {
    if (!openDropdown || !openDropdown.el) return;
    if (!openDropdown.el.contains(event.target)) closeOpenDropdown();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeOpenDropdown();
  });
}

function resolveText(entry) {
  return typeof entry === "function" ? entry() : entry == null ? "" : String(entry);
}

function normalizeOptions(raw) {
  var groups = [];
  (raw || []).forEach(function (entry) {
    if (!entry) return;
    if (Array.isArray(entry.items)) {
      groups.push({
        group: entry.group == null ? "" : String(entry.group),
        items: entry.items
          .filter(function (it) { return it && it.value !== undefined && it.value !== null; })
          .map(function (it) {
            return { value: String(it.value), label: it.label == null ? String(it.value) : String(it.label) };
          }),
      });
    } else if (entry.value !== undefined && entry.value !== null) {
      groups.push({
        group: "",
        items: [{ value: String(entry.value), label: entry.label == null ? String(entry.value) : String(entry.label) }],
      });
    }
  });
  return groups;
}

export function createSearchableDropdown(config) {
  var cfg = config || {};
  var container = cfg.container;
  if (!container) throw new Error("createSearchableDropdown: container is required");

  var state = {
    groups: normalizeOptions(cfg.initialOptions),
    value: cfg.initialValue == null ? "" : String(cfg.initialValue),
    custom: false,
    open: false,
    activeIndex: -1,
    disabled: false,
  };

  function labelFor(value) {
    var found = null;
    state.groups.forEach(function (g) {
      g.items.forEach(function (it) {
        if (it.value === value) found = it.label;
      });
    });
    return found;
  }

  // --- DOM ---------------------------------------------------------------
  var el = document.createElement("div");
  el.className = "sdd";

  var field = document.createElement("button");
  field.type = "button";
  field.className = "sdd-field";
  field.setAttribute("aria-haspopup", "listbox");
  field.setAttribute("aria-expanded", "false");

  var iconSearch = document.createElement("span");
  iconSearch.className = "sdd-field-icon";
  iconSearch.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';

  var fieldText = document.createElement("span");
  fieldText.className = "sdd-field-text sdd-placeholder";

  var customTag = document.createElement("span");
  customTag.className = "sdd-custom-tag";
  customTag.hidden = true;

  var clearBtn = document.createElement("span");
  clearBtn.className = "sdd-clear";
  clearBtn.setAttribute("role", "button");
  clearBtn.setAttribute("tabindex", "0");
  clearBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';

  var chevron = document.createElement("span");
  chevron.className = "sdd-chevron";
  chevron.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';

  field.appendChild(iconSearch);
  field.appendChild(fieldText);
  field.appendChild(customTag);
  field.appendChild(clearBtn);
  field.appendChild(chevron);

  var panel = document.createElement("div");
  panel.className = "sdd-panel";
  panel.hidden = true;

  var searchRow = document.createElement("div");
  searchRow.className = "sdd-search-row";
  searchRow.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
  var searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "sdd-search";
  searchInput.setAttribute("autocomplete", "off");
  searchRow.appendChild(searchInput);

  var list = document.createElement("div");
  list.className = "sdd-list";
  list.setAttribute("role", "listbox");

  var customRow = document.createElement("button");
  customRow.type = "button";
  customRow.className = "sdd-custom-row";

  panel.appendChild(searchRow);
  panel.appendChild(list);
  panel.appendChild(customRow);

  el.appendChild(field);
  el.appendChild(panel);
  container.appendChild(el);

  // --- Rendering ----------------------------------------------------------
  function currentLabels() {
    return {
      placeholder: resolveText(cfg.placeholder) || "",
      searchPlaceholder: resolveText(cfg.searchPlaceholder) || "",
      customLabel: resolveText(cfg.customLabel) || "Other / Enter manually",
      useTyped: cfg.useTypedLabel || null,
      noResults: resolveText(cfg.noResultsLabel) || "",
      popular: resolveText(cfg.popularLabel) || "",
      clear: resolveText(cfg.clearLabel) || "Clear selection",
    };
  }

  function paintField() {
    var labels = currentLabels();
    customTag.textContent = labels.customLabel;
    if (state.value) {
      var shown = state.custom ? state.value : labelFor(state.value) || state.value;
      fieldText.textContent = shown;
      fieldText.classList.remove("sdd-placeholder");
      field.classList.add("sdd-has-value");
      customTag.hidden = !state.custom;
    } else {
      fieldText.textContent = labels.placeholder;
      fieldText.classList.add("sdd-placeholder");
      field.classList.remove("sdd-has-value");
      customTag.hidden = true;
    }
    clearBtn.title = labels.clear;
    clearBtn.setAttribute("aria-label", labels.clear);
    clearBtn.style.display = state.value && !state.disabled ? "" : "none";
  }

  function flatVisibleItems() {
    return Array.from(list.querySelectorAll(".sdd-option")).filter(function (n) {
      return !n.hidden;
    });
  }

  function renderList() {
    var labels = currentLabels();
    var q = searchInput.value.trim().toLowerCase();
    list.innerHTML = "";
    state.activeIndex = -1;
    var totalVisible = 0;
    var exactMatch = false;

    state.groups.forEach(function (g) {
      var matching = g.items.filter(function (it) {
        if (!q) return true;
        return (it.label + " " + it.value).toLowerCase().indexOf(q) !== -1;
      });
      if (!matching.length) return;
      if (g.group) {
        var header = document.createElement("div");
        header.className = "sdd-group";
        header.textContent = g.group;
        list.appendChild(header);
      }
      matching.forEach(function (it) {
        if (it.value.toLowerCase() === q || it.label.toLowerCase() === q) exactMatch = true;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sdd-option" + (it.value === state.value && !state.custom ? " sdd-selected" : "");
        btn.setAttribute("role", "option");
        btn.dataset.value = it.value;
        btn.innerHTML = "";
        var dot = document.createElement("span");
        dot.className = "sdd-radio";
        var txt = document.createElement("span");
        txt.className = "sdd-option-text";
        txt.textContent = it.label;
        btn.appendChild(dot);
        btn.appendChild(txt);
        btn.addEventListener("click", function () {
          pick(it.value, false);
        });
        list.appendChild(btn);
        totalVisible += 1;
      });
    });

    if (labels.popular && !q && totalVisible > 0 && !state.groups.some(function (g) { return g.group; })) {
      var cap = document.createElement("div");
      cap.className = "sdd-group";
      cap.textContent = labels.popular;
      list.insertBefore(cap, list.firstChild);
    }

    var empty = document.createElement("div");
    empty.className = "sdd-empty";
    empty.hidden = totalVisible > 0;
    empty.textContent = labels.noResults;
    list.appendChild(empty);

    // "Use ..." row: offers the typed text itself when it matches nothing.
    var typed = searchInput.value.trim();
    var showUseTyped = !!(typed && !exactMatch && cfg.allowCustom !== false);
    if (showUseTyped) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "sdd-option sdd-use-typed";
      row.dataset.value = typed;
      var useLabel = typeof labels.useTyped === "function"
        ? labels.useTyped(typed)
        : 'Use "' + typed + '"';
      var rDot = document.createElement("span");
      rDot.className = "sdd-radio sdd-radio-plus";
      rDot.innerHTML = '<i class="fa-solid fa-plus"></i>';
      var rTxt = document.createElement("span");
      rTxt.className = "sdd-option-text";
      rTxt.textContent = useLabel;
      row.appendChild(rDot);
      row.appendChild(rTxt);
      row.addEventListener("click", function () {
        pick(typed, true);
      });
      list.insertBefore(row, empty);
    }

    // Persistent "Other / Enter manually" footer row.
    if (cfg.allowCustom === false) {
      customRow.hidden = true;
    } else {
      customRow.hidden = false;
      customRow.innerHTML = "";
      var cDot = document.createElement("span");
      cDot.className = "sdd-radio sdd-radio-pen";
      cDot.innerHTML = '<i class="fa-solid fa-pen"></i>';
      var cTxt = document.createElement("span");
      cTxt.textContent = labels.customLabel;
      customRow.appendChild(cDot);
      customRow.appendChild(cTxt);
    }
  }

  // --- Behaviour -----------------------------------------------------------
  function notify() {
    if (typeof cfg.onChange === "function") {
      cfg.onChange(state.value, { custom: state.custom });
    }
  }

  function pick(value, custom) {
    state.value = value == null ? "" : String(value);
    state.custom = !!custom;
    paintField();
    api.close();
    notify();
  }

  function syncSearchBox() {
    searchInput.value = "";
    searchInput.placeholder = currentLabels().searchPlaceholder;
  }

  var api = {
    el: el,
    open: function () {
      if (state.disabled) return;
      closeOpenDropdown();
      openDropdown = api;
      state.open = true;
      panel.hidden = false;
      field.setAttribute("aria-expanded", "true");
      el.classList.add("sdd-open");
      syncSearchBox();
      renderList();
      setTimeout(function () {
        try { searchInput.focus(); } catch (e) {}
      }, 0);
    },
    close: function () {
      if (!state.open) return;
      state.open = false;
      panel.hidden = true;
      field.setAttribute("aria-expanded", "false");
      el.classList.remove("sdd-open");
      if (openDropdown === api) openDropdown = null;
    },
    isOpen: function () { return state.open; },
    getValue: function () { return state.value; },
    isCustomValue: function () { return state.custom && !!state.value; },
    setOptions: function (raw) {
      state.groups = normalizeOptions(raw);
      if (state.open) renderList();
    },
    setValue: function (value, opts) {
      var o = opts || {};
      state.value = value == null ? "" : String(value);
      state.custom = !!o.custom;
      paintField();
      if (state.open) renderList();
      if (!o.silent) notify();
    },
    setCustomValue: function (text) {
      state.value = text == null ? "" : String(text);
      state.custom = !!state.value;
      paintField();
      if (state.open) renderList();
    },
    clear: function (silent) {
      state.value = "";
      state.custom = false;
      paintField();
      if (state.open) { syncSearchBox(); renderList(); }
      if (!silent) notify();
    },
    refresh: function () {
      paintField();
      if (state.open) { syncSearchBox(); renderList(); }
    },
    focusField: function () {
      try { field.focus(); } catch (e) {}
    },
    setDisabled: function (disabled) {
      state.disabled = !!disabled;
      field.disabled = state.disabled;
      paintField();
    },
  };

  field.addEventListener("click", function (event) {
    if (state.disabled) return;
    if (event.target === clearBtn || clearBtn.contains(event.target)) return;
    if (state.open) api.close();
    else api.open();
  });

  clearBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    api.clear();
    api.focusField();
  });
  clearBtn.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      api.clear();
    }
  });

  searchInput.addEventListener("input", renderList);
  searchInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      var visible = flatVisibleItems();
      if (visible.length) {
        var first = visible[0].classList.contains("sdd-use-typed")
          ? visible[0]
          : visible.filter(function (n) { return !n.classList.contains("sdd-use-typed"); })[0] || visible[0];
        first.click();
      } else {
        customRow.click();
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      var items = flatVisibleItems();
      if (!items.length) return;
      state.activeIndex = event.key === "ArrowDown"
        ? Math.min(items.length - 1, state.activeIndex + 1)
        : Math.max(0, state.activeIndex - 1);
      items.forEach(function (n, i) {
        n.classList.toggle("sdd-active", i === state.activeIndex);
      });
      var node = items[state.activeIndex];
      if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
    }
  });

  customRow.addEventListener("click", function () {
    var typed = searchInput.value.trim();
    if (typed) {
      pick(typed, true);
      return;
    }
    try { searchInput.focus(); } catch (e) {}
    searchInput.placeholder = currentLabels().customLabel + "...";
  });

  paintField();
  return api;
}
