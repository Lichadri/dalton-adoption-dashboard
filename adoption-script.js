const fs = require("fs");
const path = require("path");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const CONFIG_PATH = path.join(__dirname, "files-config.json");
const HISTORY_PATH = path.join(__dirname, "adoption-history.json");
const REPORT_PATH = path.join(__dirname, "docs", "report.json");

// Dalton DS library keys
const DALTON_KEYS = {
  components: "IDBzmWEtnNBVSQTixgXWjy",
  icons: "EVpXx1jLdKLIDLyyn2kTWa",
  foundations: "1j9PKhuBbltHSFhq2Dogvg",
};

// Known Dalton component name prefixes (fallback when library is unpublished)
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

// Get annotations for a file (Ready for Dev badges)
async function getReadyForDevAnnotations(fileKey) {
  try {
    const data = await figmaFetch(`/files/${fileKey}/annotations`);
    const rfDevAnnotations = (data.annotations || []).filter(
      (a) => a.label && a.label.toLowerCase().includes("ready for dev")
    );
    return rfDevAnnotations.map((a) => a.node_id || a.anchor?.node_id).filter(Boolean);
  } catch (e) {
    console.warn(`  Annotations error for ${fileKey}:`, e.message);
    return [];
  }
}

// Traverse nodes and count DS vs non-DS component instances
function countInstances(node, daltonComponentKeys, counts = { ds: 0, nonDs: 0 }) {
  if (!node) return counts;

  if (node.type === "INSTANCE") {
    const compKey = node.componentId;
    const compName = node.name || "";

    const isDaltonByKey =
      compKey && daltonComponentKeys.has(compKey);

    const isDaltonByName =
      !isDaltonByKey &&
      DALTON_COMPONENT_PREFIXES.some((prefix) =>
        compName.startsWith(prefix)
      );

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

// Get Dalton component keys from the library file
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

// Get nodes for specific IDs (page-by-page to avoid 413)
async function getNodes(fileKey, nodeIds) {
  if (!nodeIds.length) return {};
  const chunks = [];
  for (let i = 0; i < nodeIds.length; i += 10) {
    chunks.push(nodeIds.slice(i, i + 10));
  }
  const allNodes = {};
  for (const chunk of chunks) {
    try {
      const data = await figmaFetch(
        `/files/${fileKey}/nodes?ids=${chunk.join(",")}&depth=10`
      );
      Object.assign(allNodes, data.nodes || {});
    } catch (e) {
      console.warn(`  Node fetch error:`, e.message);
    }
    await sleep(800);
  }
  return allNodes;
}

// Get all pages and their top-level frames
async function getPagesAndFrames(fileKey) {
  const data = await figmaFetch(`/files/${fileKey}?depth=1`);
  return (data.document?.children || []).filter((p) => p.type === "CANVAS");
}

async function analyzeFile(fileKey, fileName, daltonComponentKeys) {
  console.log(`\n  Analyzing: ${fileName} (${fileKey})`);

  // Step 1: Get Ready for Dev node IDs
  const rfdNodeIds = await getReadyForDevAnnotations(fileKey);
  console.log(`  Ready for Dev annotations found: ${rfdNodeIds.length}`);

  let rfdFrameCount = 0;
  let dsInstances = 0;
  let nonDsInstances = 0;

  if (rfdNodeIds.length > 0) {
    // Step 2: Fetch the actual nodes
    const nodes = await getNodes(fileKey, rfdNodeIds);
    rfdFrameCount = Object.keys(nodes).length;

    // Step 3: Count instances inside each RFD node
    for (const [, nodeData] of Object.entries(nodes)) {
      const node = nodeData?.document;
      if (!node) continue;
      const counts = countInstances(node, daltonComponentKeys);
      dsInstances += counts.ds;
      nonDsInstances += counts.nonDs;
    }
  }

  const totalInstances = dsInstances + nonDsInstances;
  const adoptionRate =
    totalInstances > 0 ? Math.round((dsInstances / totalInstances) * 100) : 0;

  console.log(
    `  Frames RFD: ${rfdFrameCount} | DS: ${dsInstances} | Non-DS: ${nonDsInstances} | Rate: ${adoptionRate}%`
  );

  return {
    key: fileKey,
    name: fileName,
    rfdFrameCount,
    dsInstances,
    nonDsInstances,
    totalInstances,
    adoptionRate,
  };
}

async function run() {
  if (!FIGMA_TOKEN) {
    console.error("ERROR: FIGMA_TOKEN environment variable not set");
    process.exit(1);
  }

  console.log("=== Dalton DS Adoption Report ===");
  console.log(`Date: ${new Date().toISOString()}\n`);

  // Load config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  // Load history
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  }

  // Get Dalton component keys
  console.log("Loading Dalton component keys...");
  const daltonComponentKeys = await getDaltonComponentKeys();
  await sleep(1000);

  // Analyze each team
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
        filesData.push({
          key: file.key,
          name: file.name,
          error: e.message,
          rfdFrameCount: 0,
          dsInstances: 0,
          nonDsInstances: 0,
          totalInstances: 0,
          adoptionRate: 0,
        });
      }
      await sleep(1500);
    }

    // Team aggregates
    const totalRfdFrames = filesData.reduce((s, f) => s + f.rfdFrameCount, 0);
    const totalDs = filesData.reduce((s, f) => s + f.dsInstances, 0);
    const totalNonDs = filesData.reduce((s, f) => s + f.nonDsInstances, 0);
    const totalInstances = totalDs + totalNonDs;
    const teamAdoptionRate =
      totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;

    teamsData.push({
      name: team.name,
      adoptionRate: teamAdoptionRate,
      totalRfdFrames,
      totalDs,
      totalNonDs,
      totalInstances,
      files: filesData,
    });
  }

  // Build quarter label (Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec)
  const now = new Date();
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const dateStr = now.toISOString().split("T")[0];

  // Save to history (one entry per quarter per team)
  for (const team of teamsData) {
    const existingIdx = history.findIndex(
      (h) => h.team === team.name && h.quarter === quarter
    );
    const entry = {
      team: team.name,
      quarter,
      date: dateStr,
      adoptionRate: team.adoptionRate,
      totalRfdFrames: team.totalRfdFrames,
      totalDs: team.totalDs,
      totalInstances: team.totalInstances,
    };
    if (existingIdx >= 0) {
      history[existingIdx] = entry; // update current quarter
    } else {
      history.push(entry);
    }
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  // Build final report
  const report = {
    generatedAt: now.toISOString(),
    quarter,
    teams: teamsData,
    history,
  };

  // Ensure docs dir exists
  if (!fs.existsSync(path.join(__dirname, "docs"))) {
    fs.mkdirSync(path.join(__dirname, "docs"));
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n✓ Report saved to docs/report.json`);
  console.log("\n=== Summary ===");
  for (const team of teamsData) {
    console.log(`${team.name}: ${team.adoptionRate}% adoption (${team.totalRfdFrames} RFD frames)`);
  }
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
