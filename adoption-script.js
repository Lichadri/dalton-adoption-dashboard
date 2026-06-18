const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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
  // Sub-componentes Dalton
  "type_option", "section_footer", "src_option_redes", "src_option_stores_download",
  "title_+_options", "title_+_phones", "title_+_social media",
  "Tag", "reemplazar slot", "compare_arrow", "Átomo", "Indicator step",
  "Left Label", "Label in", "Dropdown Input", "Indicator Circle",
];
const FAMILIES_LOWER = DALTON_COMPONENT_FAMILIES.map(f => f.toLowerCase());

// Known icons to exclude from count
const EXCLUDED_ICONS = new Set([
  "arrow down", "arrow right", "arrow left", "arrow up",
  "desktop", "home", "person", "search", "viajes",
  "work experience icon", "business center", "up", "arrowright",
  "check", "edit", "delete", "plus", "minus", "close", "logo","compare_arrow",
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
  if (EXCLUDED_ICONS.has(lastName) || EXCLUDED_ICONS.has(lower)) return "exclude";
  const segments = lower.split("/").map(s => s.trim());
  for (const segment of segments) {
    for (const fam of FAMILIES_LOWER) {
      if (segment === fam || segment.startsWith(fam + " ") || segment.startsWith(fam + "_")) return "Components";
    }
  }
  for (const fam of FAMILIES_LOWER) {
    if (lower.startsWith(fam)) return "Components";
  }
  return "internal";
}

function findReadyForDevNodes(node, found = []) {
  if (!node) return found;
  if (node.devStatus && node.devStatus.type === "READY_FOR_DEV") { found.push(node.id); return found; }
  if (node.children) for (const child of node.children) findReadyForDevNodes(child, found);
  return found;
}

function findNodeById(node, targetId) {
  if (!node) return null;
  if (node.id === targetId) return node;
  if (node.children) { for (const child of node.children) { const f = findNodeById(child, targetId); if (f) return f; } }
  return null;
}

function countInstances(node, result) {
  if (!node) return;
  if (node.type === "INSTANCE") {
    const lib = classify(node.name);
    if (lib !== "exclude") {
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
  } catch (e) { console.warn(`  Error page ${pageId}:`, e.message); return null; }
}

async function analyzeFile(fileKey, fileName) {
  console.log(`\n  Analyzing: ${fileName}`);
  let rfdFrameCount = 0;
  const result = { Components: { count: 0, names: {} }, internal: { count: 0, names: {} } };
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
  const top20Internal = Object.entries(result.internal.names).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }));
  console.log(`  RFD: ${rfdFrameCount} | DS: ${result.Components.count} | Internal: ${result.internal.count} | Rate: ${adoptionRate}%`);
  return { key: fileKey, name: fileName, rfdFrameCount, dsInstances: totalDs, internalInstances: result.internal.count, totalInstances, adoptionRate, top20Internal };
}

// Generate Excel report using Python/openpyxl
function generateExcel(report, outputPath) {
  const data = JSON.stringify(report);
  const script = `
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

report = json.loads('''${data.replace(/'/g, "\\'")}''')
wb = Workbook()

CYAN = "FF1A7FA8"
CYAN_LIGHT = "FFE8F4F9"
GRAY = "FFF1F3F5"
GRAY_MID = "FFE9ECEF"
WHITE = "FFFFFFFF"
DARK = "FF212529"
GREEN = "FF1D9E75"
RED = "FFD94F3D"
YELLOW = "FFF5A623"

def header_cell(ws, row, col, value, bg=CYAN, fg=WHITE, bold=True, size=11):
    c = ws.cell(row=row, column=col, value=value)
    c.font = Font(bold=bold, color=fg, size=size, name="Arial")
    c.fill = PatternFill("solid", start_color=bg)
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    return c

def data_cell(ws, row, col, value, bold=False, align="left", color=None):
    c = ws.cell(row=row, column=col, value=value)
    c.font = Font(bold=bold, color=color or DARK, size=10, name="Arial")
    c.alignment = Alignment(horizontal=align, vertical="center")
    return c

def rate_color(rate):
    if rate >= 75: return GREEN
    if rate >= 50: return YELLOW
    return RED

thin = Side(style="thin", color="FFE9ECEF")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

# ── HOJA 1: RESUMEN ──────────────────────────────────────────────
ws1 = wb.active
ws1.title = "Resumen"
ws1.sheet_view.showGridLines = False
ws1.row_dimensions[1].height = 40
ws1.row_dimensions[2].height = 20

# Title
title = ws1.cell(row=1, column=1, value="Dalton DS — Reporte de Adopción")
title.font = Font(bold=True, size=16, color=DARK, name="Arial")
title.alignment = Alignment(vertical="center")
ws1.merge_cells("A1:G1")

quarter = ws1.cell(row=2, column=1, value=f"Quarter: {report['quarter']}  |  Generado: {report['generatedAt'][:10]}")
quarter.font = Font(size=9, color="FF6C757D", name="Arial")
ws1.merge_cells("A2:G2")

# Headers row 4
ws1.row_dimensions[4].height = 28
headers = ["Categoría", "Activo", "Archivos", "Frames RFD", "Inst. DS", "Internos", "Adopción %"]
for i, h in enumerate(headers, 1):
    header_cell(ws1, 4, i, h)

# Data
row = 5
for team in report["teams"]:
    ws1.row_dimensions[row].height = 22
    data_cell(ws1, row, 1, team.get("category", team["name"]))
    data_cell(ws1, row, 2, team["name"], bold=True)
    data_cell(ws1, row, 3, len(team["files"]), align="center")
    data_cell(ws1, row, 4, team["totalRfdFrames"], align="center")
    data_cell(ws1, row, 5, team["dsInstances"], align="center", color="FF1A7FA8")
    data_cell(ws1, row, 6, team["internalInstances"], align="center")
    rate = team["adoptionRate"]
    c = data_cell(ws1, row, 7, f"{rate}%", bold=True, align="center", color=rate_color(rate))
    row += 1

# Totals
ws1.row_dimensions[row].height = 24
total_rfd = sum(t["totalRfdFrames"] for t in report["teams"])
total_ds = sum(t["dsInstances"] for t in report["teams"])
total_int = sum(t["internalInstances"] for t in report["teams"])
total_inst = sum(t["totalInstances"] for t in report["teams"])
avg_rate = round((total_ds / total_inst) * 100) if total_inst > 0 else 0

for col in range(1, 8):
    c = ws1.cell(row=row, column=col)
    c.fill = PatternFill("solid", start_color=CYAN_LIGHT)
    c.font = Font(bold=True, size=10, color=DARK, name="Arial")
    c.alignment = Alignment(horizontal="center", vertical="center")

ws1.cell(row=row, column=1, value="TOTAL").font = Font(bold=True, size=10, color=DARK, name="Arial")
ws1.merge_cells(f"A{row}:B{row}")
ws1.cell(row=row, column=1).alignment = Alignment(horizontal="center", vertical="center")
ws1.cell(row=row, column=3, value=sum(len(t["files"]) for t in report["teams"]))
ws1.cell(row=row, column=4, value=total_rfd)
ws1.cell(row=row, column=5, value=total_ds).font = Font(bold=True, color="FF1A7FA8", size=10, name="Arial")
ws1.cell(row=row, column=6, value=total_int)
ws1.cell(row=row, column=7, value=f"{avg_rate}%").font = Font(bold=True, color=rate_color(avg_rate), size=10, name="Arial")

# Column widths
for col, w in zip(range(1, 8), [18, 28, 10, 12, 12, 12, 12]):
    ws1.column_dimensions[get_column_letter(col)].width = w

# ── HOJA 2: POR ARCHIVO ─────────────────────────────────────────
ws2 = wb.create_sheet("Por archivo")
ws2.sheet_view.showGridLines = False
headers2 = ["Categoría", "Activo", "Archivo", "Frames RFD", "Inst. DS", "Internos", "Total", "Adopción %"]
ws2.row_dimensions[1].height = 28
for i, h in enumerate(headers2, 1):
    header_cell(ws2, 1, i, h)

row = 2
for team in report["teams"]:
    for f in team["files"]:
        ws2.row_dimensions[row].height = 20
        data_cell(ws2, row, 1, team.get("category", team["name"]))
        data_cell(ws2, row, 2, team["name"])
        data_cell(ws2, row, 3, f["name"], bold=True)
        data_cell(ws2, row, 4, f["rfdFrameCount"], align="center")
        data_cell(ws2, row, 5, f["dsInstances"], align="center", color="FF1A7FA8")
        data_cell(ws2, row, 6, f["internalInstances"], align="center")
        data_cell(ws2, row, 7, f["totalInstances"], align="center")
        rate = f["adoptionRate"]
        data_cell(ws2, row, 8, f"{rate}%", bold=True, align="center", color=rate_color(rate))
        row += 1

for col, w in zip(range(1, 9), [18, 22, 32, 12, 12, 12, 12, 12]):
    ws2.column_dimensions[get_column_letter(col)].width = w

# ── HOJA 3: COMPONENTES INTERNOS ────────────────────────────────
ws3 = wb.create_sheet("Componentes internos")
ws3.sheet_view.showGridLines = False
headers3 = ["Categoría", "Activo", "Componente interno", "Instancias"]
ws3.row_dimensions[1].height = 28
for i, h in enumerate(headers3, 1):
    header_cell(ws3, 1, i, h)

row = 2
for team in report["teams"]:
    for item in (team.get("top20Internal") or []):
        ws3.row_dimensions[row].height = 20
        data_cell(ws3, row, 1, team.get("category", team["name"]))
        data_cell(ws3, row, 2, team["name"])
        data_cell(ws3, row, 3, item["name"])
        data_cell(ws3, row, 4, item["count"], align="center", bold=True)
        row += 1

for col, w in zip(range(1, 5), [18, 22, 36, 14]):
    ws3.column_dimensions[get_column_letter(col)].width = w

# ── HOJA 4: HISTORIAL ───────────────────────────────────────────
ws4 = wb.create_sheet("Historial")
ws4.sheet_view.showGridLines = False
headers4 = ["Equipo", "Quarter", "Fecha", "Adopción %", "Frames RFD", "Inst. DS", "Total"]
ws4.row_dimensions[1].height = 28
for i, h in enumerate(headers4, 1):
    header_cell(ws4, 1, i, h)

row = 2
for entry in sorted(report.get("history", []), key=lambda x: (x["team"], x["quarter"])):
    ws4.row_dimensions[row].height = 20
    data_cell(ws4, row, 1, entry["team"], bold=True)
    data_cell(ws4, row, 2, entry["quarter"], align="center")
    data_cell(ws4, row, 3, entry.get("date", ""))
    rate = entry["adoptionRate"]
    data_cell(ws4, row, 4, f"{rate}%", bold=True, align="center", color=rate_color(rate))
    data_cell(ws4, row, 5, entry.get("totalRfdFrames", 0), align="center")
    data_cell(ws4, row, 6, entry.get("totalDs", 0), align="center", color="FF1A7FA8")
    data_cell(ws4, row, 7, entry.get("totalInstances", 0), align="center")
    row += 1

for col, w in zip(range(1, 8), [24, 12, 14, 12, 12, 12, 12]):
    ws4.column_dimensions[get_column_letter(col)].width = w

wb.save("${outputPath}")
print("Excel saved")
`;
  try {
    execSync(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, { stdio: 'pipe' });
    console.log(`  Excel saved to ${outputPath}`);
  } catch(e) {
    // Try alternative approach with temp file
    const tmpScript = '/tmp/gen_excel.py';
    fs.writeFileSync(tmpScript, script.replace(/\$\{outputPath\}/g, outputPath));
    execSync(`python3 ${tmpScript}`, { stdio: 'inherit' });
  }
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
    console.log(`\nTeam: ${team.name} (${team.category || team.name})`);
    const filesData = [];
    for (const file of team.files) {
      try { filesData.push(await analyzeFile(file.key, file.name)); }
      catch (e) {
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
    const teamTop20Internal = Object.entries(aggregatedInternal).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }));

    teamsData.push({
      name: team.name,
      category: team.category || team.name,
      adoptionRate: teamAdoptionRate,
      totalRfdFrames, totalDs: totalDs, dsInstances: totalDs,
      internalInstances: totalInternal, totalInternal, totalInstances,
      top20Internal: teamTop20Internal, files: filesData,
    });
  }

  const now = new Date();
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const dateStr = now.toISOString().split("T")[0];

  for (const team of teamsData) {
    const existingIdx = history.findIndex(h => h.team === team.name && h.quarter === quarter);
    const entry = { team: team.name, category: team.category, quarter, date: dateStr, adoptionRate: team.adoptionRate, totalRfdFrames: team.totalRfdFrames, totalDs: team.dsInstances, totalInstances: team.totalInstances };
    if (existingIdx >= 0) { history[existingIdx] = entry; } else { history.push(entry); }
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  const report = { generatedAt: now.toISOString(), quarter, teams: teamsData, history };
  if (!fs.existsSync(path.join(__dirname, "docs"))) fs.mkdirSync(path.join(__dirname, "docs"));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // Generate Excel
  const excelPath = path.join(__dirname, "docs", "reporte-adopcion.xlsx");
  generateExcel(report, excelPath);

  console.log(`\nReport saved to docs/report.json`);
 console.log("\n=== Summary ===");
  for (const team of teamsData) {
    console.log(`[${team.category}] ${team.name}: ${team.adoptionRate}% | ${team.totalRfdFrames} RFD frames`);
  }

  // Lista completa de componentes internos únicos
  const allInternalNames = {};
  for (const team of teamsData) {
    for (const { name, count } of (team.top20Internal || [])) {
      allInternalNames[name] = (allInternalNames[name] || 0) + count;
    }
  }
  console.log("\n=== Componentes internos únicos (todos los equipos) ===");
  const sorted = Object.entries(allInternalNames).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`  ${count.toString().padStart(6)} | ${name}`);
  }
  console.log(
}

run().catch(e => { console.error("Fatal error:", e); process.exit(1); });
