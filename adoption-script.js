const fs = require("fs");
const path = require("path");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const CONFIG_PATH = path.join(__dirname, "files-config.json");
const HISTORY_PATH = path.join(__dirname, "adoption-history.json");
const REPORT_PATH = path.join(__dirname, "docs", "report.json");

const DS_LIBS = [
  { key: "IDBzmWEtnNBVSQTixgXWjy", label: "Components" },
  { key: "EVpXx1jLdKLIDLyyn2kTWa", label: "Icons" },
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

// Load published component keys from DS libraries
// Uses /files/:key/components which works even with unpublished changes
async function loadLibraryKeys() {
  const libMaps = {};
  for (const lib of DS_LIBS) {
    const data = await figmaFetch(`/files/${lib.key}/components`);
    const comps = data.meta?.components || [];
    libMaps[lib.label] = {
      keySet: new Set(comps.map(c => c.key)),
      keyToName: new Map(comps.map(c => [c.key, c.name])),
      total: comps.length,
    };
    console.log(`  ${lib.label}: ${comps.length} published components`);
    await sleep(800);
  }
  return libMaps;
}

function findReadyForDevNodes(node, found = []) {
  if (!node) return found;
  if (node.devStatus && node.devStatus.type === "READY_FOR_DEV") {
    found.push(node.id);
    return found;
  }
  if (node.children) {
    for (const child of node.children) findReadyForDevNodes(child, found);
  }
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

// Count instances inside a node, using localIdToKey for cross-file matching
function countInstances(node, libMaps, localIdToKey, localIdToName, result) {
  if (!node) return;

  if (node.type === "INSTANCE" && node.componentId) {
    const compKey = localIdToKey.get(node.componentId);
    let matched = false;

    for (const lib of DS_LIBS) {
      if (compKey && libMaps[lib.label].keySet.has(compKey)) {
        const name = libMaps[lib.label].keyToName.get(compKey) || node.name;
        result[lib.label].count++;
        result[lib.label].names[name] = (result[lib.label].names[name] || 0) + 1;
        matched = true;
        break;
      }
    }

    if (!matched) {
      result.internal.count++;
      const name = (localIdToName.get(node.componentId) || node.name || "Sin nombre").split("/").pop().trim();
      result.internal.names[name] = (result.internal.names[name] || 0) + 1;
    }
  }

  if (node.children) {
    for (const child of node.children) {
      countInstances(child, libMaps, localIdToKey, localIdToName, result);
    }
  }
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
    console.warn(`  Error fetching page ${pageId}:`, e.message);
    return null;
  }
}

async function analyzeFile(fileKey, fileName, libMaps) {
  console.log(`\n  Analyzing: ${fileName}`);

  // Build local component key map from file metadata
  const fileMeta = await figmaFetch(`/files/${fileKey}?depth=1`);
  const localIdToKey = new Map();
  const localIdToName = new Map();
  Object.entries(fileMeta.components || {}).forEach(([id, c]) => {
    if (c.key) localIdToKey.set(id, c.key);
    if (c.name) localIdToName.set(id, c.name);
  });
  console.log(`  Local component map: ${localIdToKey.size} entries`);
  await sleep(800);

  let rfdFrameCount = 0;
  const result = {
    Components: { count: 0, names: {} },
    Icons: { count: 0, names: {} },
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
    if (rfdInPage.length > 0) {
      console.log(`    Page "${page.name}": ${rfdInPage.length} RFD`);
    }

    for (const nodeId of rfdInPage) {
      const rfdNode = findNodeById(pageNode, nodeId);
      if (!rfdNode) continue;
      rfdFrameCount++;
      countInstances(rfdNode, libMaps, localIdToKey, localIdToName, result);
    }
    await sleep(800);
  }

  const totalDs = result.Components.count + result.Icons.count;
  const totalInstances = totalDs + result.internal.count;
  const adoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;
  const componentsRate = totalInstances > 0 ? Math.round((result.Components.count / totalInstances) * 100) : 0;
  const iconsRate = totalInstances > 0 ? Math.round((result.Icons.count / totalInstances) * 100) : 0;

  // Unique families used
  const uniqueComponents = new Set(Object.keys(result.Components.names)).size;
  const uniqueIcons = new Set(Object.keys(result.Icons.names)).size;

  // Top 20 internal
  const top20Internal = Object.entries(result.internal.names)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  console.log(`  RFD: ${rfdFrameCount} | DS: ${totalDs} (C:${result.Components.count} I:${result.Icons.count}) | Internal: ${result.internal.count} | Rate: ${adoptionRate}%`);

  return {
    key: fileKey, name: fileName, rfdFrameCount,
    dsInstances: totalDs,
    componentsInstances: result.Components.count,
    iconsInstances: result.Icons.count,
    internalInstances: result.internal.count,
    totalInstances, adoptionRate, componentsRate, iconsRate,
    uniqueComponentsUsed: uniqueComponents,
    uniqueIconsUsed: uniqueIcons,
    totalComponentsInLibrary: libMaps.Components.total,
    totalIconsInLibrary: libMaps.Icons.total,
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

  console.log("Loading DS library keys...");
  const libMaps = await loadLibraryKeys();
  await sleep(1000);

  const teamsData = [];

  for (const team of config.teams) {
    console.log(`\nTeam: ${team.name}`);
    const filesData = [];

    for (const file of team.files) {
      try {
        filesData.push(await analyzeFile(file.key, file.name, libMaps));
      } catch (e) {
        console.error(`  Error: ${file.name}:`, e.message);
        filesData.push({
          key: file.key, name: file.name, error: e.message,
          rfdFrameCount: 0, dsInstances: 0, componentsInstances: 0,
          iconsInstances: 0, internalInstances: 0, totalInstances: 0,
          adoptionRate: 0, componentsRate: 0, iconsRate: 0,
          uniqueComponentsUsed: 0, uniqueIconsUsed: 0,
          totalComponentsInLibrary: libMaps.Components.total,
          totalIconsInLibrary: libMaps.Icons.total,
          top20Internal: [],
        });
      }
      await sleep(1500);
    }

    // Team aggregates
    const totalRfdFrames = filesData.reduce((s, f) => s + f.rfdFrameCount, 0);
    const totalDs = filesData.reduce((s, f) => s + f.dsInstances, 0);
    const totalComponents = filesData.reduce((s, f) => s + f.componentsInstances, 0);
    const totalIcons = filesData.reduce((s, f) => s + f.iconsInstances, 0);
    const totalInternal = filesData.reduce((s, f) => s + f.internalInstances, 0);
    const totalInstances = totalDs + totalInternal;
    const teamAdoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;
    const teamComponentsRate = totalInstances > 0 ? Math.round((totalComponents / totalInstances) * 100) : 0;
    const teamIconsRate = totalInstances > 0 ? Math.round((totalIcons / totalInstances) * 100) : 0;
    const uniqueComponentsUsed = filesData.reduce((s, f) => s + f.uniqueComponentsUsed, 0);
    const uniqueIconsUsed = filesData.reduce((s, f) => s + f.uniqueIconsUsed, 0);

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
      totalRfdFrames, totalDs, totalComponents, totalIcons,
      totalInternal, totalInstances,
      componentsRate: teamComponentsRate, iconsRate: teamIconsRate,
      uniqueComponentsUsed, uniqueIconsUsed,
      totalComponentsInLibrary: libMaps.Components.total,
      totalIconsInLibrary: libMaps.Icons.total,
      top20Internal: teamTop20Internal, files: filesData,
    });
  }

  const now = new Date();
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const dateStr = now.toISOString().split("T")[0];

  for (const team of teamsData) {
    const existingIdx = history.findIndex(h => h.team === team.name && h.quarter === quarter);
    const entry = {
      team: team.name, quarter, date: dateStr,
      adoptionRate: team.adoptionRate,
      componentsRate: team.componentsRate,
      iconsRate: team.iconsRate,
      totalRfdFrames: team.totalRfdFrames,
      totalDs: team.totalDs, totalInstances: team.totalInstances,
    };
    if (existingIdx >= 0) { history[existingIdx] = entry; } else { history.push(entry); }
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  const report = {
    generatedAt: now.toISOString(), quarter,
    totalComponentsInLibrary: libMaps.Components.total,
    totalIconsInLibrary: libMaps.Icons.total,
    teams: teamsData, history,
  };

  if (!fs.existsSync(path.join(__dirname, "docs"))) fs.mkdirSync(path.join(__dirname, "docs"));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`\nReport saved to docs/report.json`);
  console.log("\n=== Summary ===");
  for (const team of teamsData) {
    console.log(`${team.name}: ${team.adoptionRate}% total (C:${team.componentsRate}% I:${team.iconsRate}%) | ${team.totalRfdFrames} RFD frames`);
  }
}

run().catch(e => { console.error("Fatal error:", e); process.exit(1); });
