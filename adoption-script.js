const fs = require("fs");
const path = require("path");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const CONFIG_PATH = path.join(__dirname, "files-config.json");
const HISTORY_PATH = path.join(__dirname, "adoption-history.json");
const REPORT_PATH = path.join(__dirname, "docs", "report.json");

// Dalton component families (exact names from library)
const DALTON_COMPONENT_FAMILIES = [
  "Accordion", "Alert", "Avatar", "Badges", "Breadcrumb", "Button",
  "Calendar", "Calendar v.2", "Cards", "Animations", "Cards I", "Cards II",
  "Checkbox", "Chips", "Comparador", "Controls", "Covers",
  "File uploader", "Footer", "Header", "Hero", "Infografia", "Input",
  "Links", "Loader", "Main Search", "Modals", "Pagination", "Progress bar",
  "Radio", "Select", "Sidebar", "Status Message", "Stepper", "Tab",
  "Table", "Text Area", "Toggle", "Tooltips", "Tracking", "Whatsapp float",
];
const FAMILIES_LOWER = DALTON_COMPONENT_FAMILIES.map(f => f.toLowerCase());

// Icons to exclude from count (known Dalton icons with non-prefixed names)
const EXCLUDED_ICONS = new Set([
  "arrow down", "arrow right", "arrow left", "arrow up",
  "desktop", "home", "person", "search", "viajes",
  "work experience icon", "business center", "up", "arrowright",
  "check", "edit", "delete", "plus", "minus", "close",
  "logo",
]);


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function figmaFetch(endpoint) {
  const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: { "X-Figma-Token": FIGMA_TOKEN },
  });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  return res.json();
}

function classify(name) {
  if (!name) return "internal";
  const lower = name.toLowerCase();
  const lastName = lower.split("/").pop().trim();

  // Exclude known icons from count entirely
  if (EXCLUDED_ICONS.has(lastName) || EXCLUDED_ICONS.has(lower)) return "exclude";

  const segments = lower.split("/").map(s => s.trim());
  for (const segment of segments) {
    for (const fam of FAMILIES_LOWER) {
      if (segment === fam || segment.startsWith(fam + " ") || segment.startsWith(fam + "_")) {
        return "Components";
      }
    }
  }
  for (const fam of FAMILIES_LOWER) {
    if (lower.startsWith(fam)) return "Components";
  }
  return "internal";
}

function findReadyForDevNodes(node, found = []) {
  if (!node) return found;
  if (node.devStatus && node.devStatus.type === "READY_FOR_DEV") {
    found.push(node.id);
    return found;
  }
  if (node.children) for (const child of node.children) findReadyForDevNodes(child, found);
  return found;
}

function findNodeById(node, targetId) {
  if (!node) return null;
  if (node.id === targetId) return node;
  if (node.children) {
    for (const child of node.children) {
      const f = findNodeById(child, targetId);
      if (f) return f;
    }
  }
  return null;
}

function countInstances(node, result) {
  if (!node) return;
  if (node.type === "INSTANCE") {
    const lib = classify(node.name);
    if (lib === "exclude") { /* skip known icons */ }
    else {
      result[lib].count++;
      const name = (node.name || "Sin nombre").split("/").pop().trim();
      result[lib].names[name] = (result[lib].names[name] || 0) + 1;
    }
  }
  if (node.children) for (const child of node.children) countInstances(child, result);
}

async function getPages(fileKey) {
  const data = await figmaFetch(`/files/${fileKey}?depth=1`);
  return (data.document?.children || []).filter(p => p.type === "CANVAS");
}

async function getPageData(fileKey, pageId) {
  try {
    const data = await figmaFetch(`/files/${fileKey}/nodes?ids=${pageId}&depth=10`);
    return data.nodes?.[pageId]?.document || null;
  } catch (e) {
    console.warn(`  Error page ${pageId}:`, e.message);
    return null;
  }
}

async function analyzeFile(fileKey, fileName) {
  console.log(`\n  Analyzing: ${fileName}`);
  let rfdFrameCount = 0;
  const result = {
    Components: { count: 0, names: {} },
    internal: { count: 0, names: {} },
  };

  const pages = await getPages(fileKey);
  console.log(`  Pages: ${pages.length}`);
  await sleep(800);

  for (const page of pages) {
    if (page.editorType === "figjam") continue;
    const pageNode = await getPageData(fileKey, page.id);
    if (!pageNode) continue;

    const rfdInPage = findReadyForDevNodes(pageNode);
    if (rfdInPage.length) console.log(`    "${page.name}": ${rfdInPage.length} RFD`);

    for (const nodeId of rfdInPage) {
      const rfdNode = findNodeById(pageNode, nodeId);
      if (!rfdNode) continue;
      rfdFrameCount++;
      countInstances(rfdNode, result);
    }
    await sleep(800);
  }

  const totalDs = result.Components.count;
  const totalInstances = totalDs + result.internal.count;
  const adoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;

  const top20Internal = Object.entries(result.internal.names)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  console.log(`  RFD: ${rfdFrameCount} | DS: ${result.Components.count} | Internal: ${result.internal.count} | Rate: ${adoptionRate}%`);

  return {
    key: fileKey, name: fileName, rfdFrameCount,
    dsInstances: totalDs,
    internalInstances: result.internal.count,
    totalInstances, adoptionRate,
    top20Internal,
  };
}

async function run() {
  if (!FIGMA_TOKEN) { console.error("ERROR: FIGMA_TOKEN not set"); process.exit(1); }

  console.log("=== Dalton DS Adoption Report ===");
  console.log(`Date: ${new Date().toISOString()}\n`);

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));

  const teamsData = [];

  for (const team of config.teams) {
    console.log(`\nTeam: ${team.name}`);
    const filesData = [];

    for (const file of team.files) {
      try {
        filesData.push(await analyzeFile(file.key, file.name));
      } catch (e) {
        console.error(`  Error: ${file.name}:`, e.message);
        filesData.push({ key: file.key, name: file.name, error: e.message, rfdFrameCount: 0, dsInstances: 0, internalInstances: 0, totalInstances: 0, adoptionRate: 0, top20Internal: [] });
      }
      await sleep(1500);
    }

    const totalRfdFrames = filesData.reduce((s, f) => s + f.rfdFrameCount, 0);
    const totalDs = filesData.reduce((s, f) => s + f.dsInstances, 0);
    const totalInternal = filesData.reduce((s, f) => s + f.internalInstances, 0);
    const totalInstances = totalDs + totalInternal;
    const teamAdoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;

    const aggregatedInternal = {};
    for (const f of filesData) {
      for (const { name, count } of (f.top20Internal || [])) {
        aggregatedInternal[name] = (aggregatedInternal[name] || 0) + count;
      }
    }
    const teamTop20Internal = Object.entries(aggregatedInternal)
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    teamsData.push({
      name: team.name, adoptionRate: teamAdoptionRate,
      totalRfdFrames, totalDs, totalInternal, totalInstances,
      top20Internal: teamTop20Internal, files: filesData,
    });
  }

  const now = new Date();
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const dateStr = now.toISOString().split("T")[0];

  for (const team of teamsData) {
    const existingIdx = history.findIndex(h => h.team === team.name && h.quarter === quarter);
    const entry = { team: team.name, quarter, date: dateStr, adoptionRate: team.adoptionRate, totalRfdFrames: team.totalRfdFrames, totalDs: team.totalDs, totalInstances: team.totalInstances };
    if (existingIdx >= 0) { history[existingIdx] = entry; } else { history.push(entry); }
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  const report = { generatedAt: now.toISOString(), quarter, teams: teamsData, history };
  if (!fs.existsSync(path.join(__dirname, "docs"))) fs.mkdirSync(path.join(__dirname, "docs"));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`\nReport saved to docs/report.json`);
  console.log("\n=== Summary ===");
  for (const team of teamsData) {
    console.log(`${team.name}: ${team.adoptionRate}% | ${team.totalRfdFrames} RFD frames`);
  }
}

run().catch(e => { console.error("Fatal error:", e); process.exit(1); });
