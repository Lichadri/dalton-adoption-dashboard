const fs = require("fs");
const path = require("path");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const CONFIG_PATH = path.join(__dirname, "files-config.json");
const HISTORY_PATH = path.join(__dirname, "adoption-history.json");
const REPORT_PATH = path.join(__dirname, "docs", "report.json");

const DALTON_KEYS = {
  components: "IDBzmWEtnNBVSQTixgXWjy",
  icons: "EVpXx1jLdKLIDLyyn2kTWa",
  foundations: "1j9PKhuBbltHSFhq2Dogvg",
};

const DALTON_COMPONENT_PREFIXES = [
  "Button", "Input", "Modal", "Card", "Badge", "Alert", "Tag",
  "Tooltip", "Checkbox", "Radio", "Select", "Table", "Tabs",
  "Accordion", "Banner", "Chip", "Divider", "Icon", "Link",
  "Pagination", "Progress", "Skeleton", "Spinner", "Switch",
  "Toast", "Avatar", "Breadcrumb", "Dropdown", "Nav",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function figmaFetch(endpoint) {
  const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: { "X-Figma-Token": FIGMA_TOKEN },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Figma API error ${res.status}: ${err}`);
  }
  return res.json();
}

function findReadyForDevNodes(node, found = []) {
  if (!node) return found;
  if (node.devStatus && node.devStatus.type === "READY_FOR_DEV") {
    found.push(node.id);
    return found;
  }
  if (node.children) {
    for (const child of node.children) {
      findReadyForDevNodes(child, found);
    }
  }
  return found;
}

function findNodeById(node, targetId) {
  if (!node) return null;
  if (node.id === targetId) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, targetId);
      if (found) return found;
    }
  }
  return null;
}

function countInstances(node, daltonComponentKeys, counts = { ds: 0, nonDs: 0 }) {
  if (!node) return counts;
  if (node.type === "INSTANCE") {
    const compKey = node.componentId;
    const compName = node.name || "";
    const isDaltonByKey = compKey && daltonComponentKeys.has(compKey);
    const isDaltonByName =
      !isDaltonByKey &&
      DALTON_COMPONENT_PREFIXES.some((prefix) => compName.startsWith(prefix));
    if (isDaltonByKey || isDaltonByName) {
      counts.ds++;
    } else {
      counts.nonDs++;
    }
  }
  if (node.children) {
    for (const child of node.children) {
      countInstances(child, daltonComponentKeys, counts);
    }
  }
  return counts;
}

async function getDaltonComponentKeys() {
  const keys = new Set();
  try {
    const data = await figmaFetch(`/files/${DALTON_KEYS.components}`);
    if (data.components) {
      for (const [, comp] of Object.entries(data.components)) {
        if (comp.key) keys.add(comp.key);
      }
    }
    console.log(`  Loaded ${keys.size} Dalton component keys`);
  } catch (e) {
    console.warn("  Could not load Dalton component keys, using name matching:", e.message);
  }
  return keys;
}

async function getPages(fileKey) {
  const data = await figmaFetch(`/files/${fileKey}?depth=1`);
  return (data.document?.children || []).filter((p) => p.type === "CANVAS");
}

async function getPageNodes(fileKey, pageId) {
  try {
    const data = await figmaFetch(`/files/${fileKey}/nodes?ids=${pageId}&depth=10`);
    return data.nodes?.[pageId]?.document || null;
  } catch (e) {
    console.warn(`  Error fetching page ${pageId}:`, e.message);
    return null;
  }
}

async function analyzeFile(fileKey, fileName, daltonComponentKeys) {
  console.log(`\n  Analyzing: ${fileName} (${fileKey})`);
  let rfdFrameCount = 0;
  let dsInstances = 0;
  let nonDsInstances = 0;

  const pages = await getPages(fileKey);
  console.log(`  Pages found: ${pages.length}`);
  await sleep(800);

  for (const page of pages) {
    if (page.editorType === "figjam") continue;
    const pageNode = await getPageNodes(fileKey, page.id);
    if (!pageNode) continue;

    const rfdInPage = findReadyForDevNodes(pageNode);
    console.log(`    Page "${page.name}": ${rfdInPage.length} RFD nodes`);

    for (const nodeId of rfdInPage) {
      const rfdNode = findNodeById(pageNode, nodeId);
      if (!rfdNode) continue;
      rfdFrameCount++;
      const counts = countInstances(rfdNode, daltonComponentKeys);
      dsInstances += counts.ds;
      nonDsInstances += counts.nonDs;
    }
    await sleep(800);
  }

  const totalInstances = dsInstances + nonDsInstances;
  const adoptionRate =
    totalInstances > 0 ? Math.round((dsInstances / totalInstances) * 100) : 0;

  console.log(`  RFD frames: ${rfdFrameCount} | DS: ${dsInstances} | Non-DS: ${nonDsInstances} | Rate: ${adoptionRate}%`);

  return { key: fileKey, name: fileName, rfdFrameCount, dsInstances, nonDsInstances, totalInstances, adoptionRate };
}

async function run() {
  if (!FIGMA_TOKEN) {
    console.error("ERROR: FIGMA_TOKEN environment variable not set");
    process.exit(1);
  }

  console.log("=== Dalton DS Adoption Report ===");
  console.log(`Date: ${new Date().toISOString()}\n`);

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  }

  console.log("Loading Dalton component keys...");
  const daltonComponentKeys = await getDaltonComponentKeys();
  await sleep(1000);

  const teamsData = [];

  for (const team of config.teams) {
    console.log(`\nTeam: ${team.name}`);
    const filesData = [];

    for (const file of team.files) {
      try {
        const result = await analyzeFile(file.key, file.name, daltonComponentKeys);
        filesData.push(result);
      } catch (e) {
        console.error(`  Error analyzing ${file.name}:`, e.message);
        filesData.push({ key: file.key, name: file.name, error: e.message, rfdFrameCount: 0, dsInstances: 0, nonDsInstances: 0, totalInstances: 0, adoptionRate: 0 });
      }
      await sleep(1500);
    }

    const totalRfdFrames = filesData.reduce((s, f) => s + f.rfdFrameCount, 0);
    const totalDs = filesData.reduce((s, f) => s + f.dsInstances, 0);
    const totalNonDs = filesData.reduce((s, f) => s + f.nonDsInstances, 0);
    const totalInstances = totalDs + totalNonDs;
    const teamAdoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;

    teamsData.push({ name: team.name, adoptionRate: teamAdoptionRate, totalRfdFrames, totalDs, totalNonDs, totalInstances, files: filesData });
  }

  const now = new Date();
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const dateStr = now.toISOString().split("T")[0];

  for (const team of teamsData) {
    const existingIdx = history.findIndex((h) => h.team === team.name && h.quarter === quarter);
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
    console.log(`${team.name}: ${team.adoptionRate}% (${team.totalRfdFrames} RFD frames)`);
  }
}

run().catch((e) => { console.error("Fatal error:", e); process.exit(1); });