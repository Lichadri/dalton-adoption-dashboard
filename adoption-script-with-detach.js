const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const CONFIG_PATH = path.join(__dirname, "files-config.json");
const HISTORY_PATH = path.join(__dirname, "adoption-history.json");
const REPORT_PATH = path.join(__dirname, "docs", "report.json");

const DALTON_LIBRARY_KEY = "IDBzmWEtnNBVSQTixgXWjy"; // Dalton Components library file key

// Mapeo Figma Team (workspace) -> categoría del dashboard
// Los nombres deben coincidir EXACTAMENTE con "team_name" que devuelve la API
const FIGMA_TEAM_TO_CATEGORY = {
  "Web Empresa": "Nueva Web Empresas",
  "Ecommerce": "Ecommerce",
  "Somos Corredores": "Somos Corredores",
  "Portal Digital de Siniestros": "Portal Digital de Siniestros",
  "WEB Corporativa": "Web Corporativa",
  "FFVV y Modelo día": "Modelo Día",
  "FFVV": "Modelo Día",
  "Embebidos": "Embebidos",
  "Protege 365": "Protege 365",
  "MEP: Mi Espacio Pacífico": "MEP",
};

const DALTON_COMPONENT_FAMILIES = [
  "Accordion", "Alert", "Avatar", "Badges", "Breadcrumb", "Button",
  "Calendar", "Calendar v.2", "Cards", "Animations", "Cards I", "Cards II",
  "Checkbox", "Chips", "Comparador", "Controls", "Covers",
  "File uploader", "Footer", "Header", "Hero", "Infografia", "Input",
  "Links", "Loader", "Main Search", "Modals", "Pagination", "Progress bar",
  "Radio", "Select", "Sidebar", "Status Message", "Stepper", "Tab",
  "Table", "Text Area", "Toggle", "Tooltips", "Tracking", "Whatsapp float",
  "type_option", "section_footer", "src_option_redes", "src_option_stores_download",
  "title_+_options", "title_+_phones", "title_+_social media",
  "Tag", "reemplazar slot", "Átomo", "Indicator step",
  "Left Label", "Label in", "Dropdown Input", "Indicator Circle",
  "Bar Progress", "Commercial Chips", "Bottom app bar", "Notification Item",
  "Discount Badge", "Menu Item", "Menu title", "Slider Controls",
  "Beneficio | card", "Beneficio | card mobile", "Banner | errores",
  "Status Control", "Card Dashboard", "Logo Horizontal",
  "Indicator number", "Chip Deleteable", "Bottom Bar", "Topbar", "Carrusel",
];
const FAMILIES_LOWER = DALTON_COMPONENT_FAMILIES.map(f => f.toLowerCase());

const EXCLUDED_ICONS = new Set([
  "arrow down", "arrow right", "arrow left", "arrow up",
  "desktop", "home", "person", "search", "viajes",
  "work experience icon", "business center", "up", "arrowright",
  "check", "edit", "delete", "plus", "minus", "close", "logo",
  "shield", "grid view", "message", "shoppingcart", "chat", "star",
  "menu", "facebook", "instagram", "tiktok", "youtube", "eye_close",
  "location", "power", "call", "account", "time", "apps", "settings", "more",
  "addcircle", "payments", "creditcard", "security", "locationpin",
  "arrow_carrousel", "compare_arrow", "generate ai", "generando ia",
  "operador", "correo electronico", "hoist", "emergency",
  "sirena emergencia", "descarga documento", "ahorros",
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
    for (let i = 0; i < FAMILIES_LOWER.length; i++) {
      const fam = FAMILIES_LOWER[i];
      if (segment === fam || segment.startsWith(fam + " ") || segment.startsWith(fam + "_")) {
        return DALTON_COMPONENT_FAMILIES[i];
      }
    }
  }
  for (let i = 0; i < FAMILIES_LOWER.length; i++) {
    if (lower.startsWith(FAMILIES_LOWER[i])) return DALTON_COMPONENT_FAMILIES[i];
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
    if (lib === "exclude") { /* skip */ }
    else if (lib === "internal") {
      result.internal.count++;
      const name = (node.name || "Sin nombre").split("/").pop().trim();
      result.internal.names[name] = (result.internal.names[name] || 0) + 1;
    } else {
      result.ds.count++;
      result.ds.families.add(lib);
      result.ds.familyCounts[lib] = (result.ds.familyCounts[lib] || 0) + 1;
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
  const result = {
    ds: { count: 0, families: new Set(), familyCounts: {} },
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

  const totalInstances = result.ds.count + result.internal.count;
  const adoptionRate = totalInstances > 0 ? Math.round((result.ds.count / totalInstances) * 100) : 0;

  const uniqueFamilies = Object.entries(result.ds.familyCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const top20Internal = Object.entries(result.internal.names)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  console.log(`  RFD: ${rfdFrameCount} | DS: ${result.ds.count} (${result.ds.families.size} familias únicas) | Internal: ${result.internal.count} | Rate: ${adoptionRate}%`);

  return {
    key: fileKey, name: fileName, rfdFrameCount,
    dsInstances: result.ds.count,
    internalInstances: result.internal.count,
    totalInstances, adoptionRate,
    uniqueFamiliesCount: result.ds.families.size,
    uniqueFamilies,
    top20Internal,
  };
}

// ============================================================
// DETACH RATE — Library Analytics API (requiere Enterprise plan)
// ============================================================

function getQuarterDateRange(date = new Date()) {
  const year = date.getFullYear();
  const quarter = Math.ceil((date.getMonth() + 1) / 3);
  const startMonth = (quarter - 1) * 3;
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0);
  const fmt = (d) => d.toISOString().split("T")[0];
  return { start: fmt(start), end: fmt(end), quarter: `Q${quarter} ${year}` };
}

async function getDetachRateByCategory() {
  console.log("\nFetching detach rate from Library Analytics API...");
  const { start, end, quarter } = getQuarterDateRange();
  console.log(`  Quarter range: ${start} to ${end} (${quarter})`);

  const categoryTotals = {};
  let cursor = null;
  let pageCount = 0;

  try {
    do {
      pageCount++;
      const params = new URLSearchParams({
        group_by: "team",
        start_date: start,
        end_date: end,
      });
      if (cursor) params.set("cursor", cursor);

      const data = await figmaFetch(
        `/analytics/libraries/${DALTON_LIBRARY_KEY}/component/actions?${params.toString()}`
      );

      for (const row of data.rows || []) {
        const teamName = row.team_name;
        const category = FIGMA_TEAM_TO_CATEGORY[teamName];
        if (!category) {
          console.log(`    (sin mapeo) team: "${teamName}" — det:${row.detachments} ins:${row.insertions}`);
          continue;
        }
        if (!categoryTotals[category]) categoryTotals[category] = { detachments: 0, insertions: 0 };
        categoryTotals[category].detachments += row.detachments || 0;
        categoryTotals[category].insertions += row.insertions || 0;
      }

      cursor = data.next_page ? data.cursor : null;
      await sleep(500);
    } while (cursor && pageCount < 20);

    console.log(`  Fetched ${pageCount} page(s) of detach data`);
  } catch (e) {
    console.warn(`  WARNING: Could not fetch detach rate — ${e.message}`);
    console.warn(`  This requires Enterprise plan + library_analytics:read scope on the token.`);
    return {};
  }

  const result = {};
  for (const [category, totals] of Object.entries(categoryTotals)) {
    const total = totals.detachments + totals.insertions;
    const rate = total > 0 ? Math.round((totals.detachments / total) * 100) : 0;
    result[category] = {
      detachments: totals.detachments,
      insertions: totals.insertions,
      detachRate: rate,
    };
    console.log(`  [${category}] detach rate: ${rate}% (${totals.detachments} detach / ${totals.insertions} insert)`);
  }

  return result;
}

function generateExcel(report, outputPath) {
  const tmpScript = '/tmp/gen_excel.py';
  const data = JSON.stringify(report).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  const script = `
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

report = json.loads('${data}')
wb = Workbook()

CYAN = "FF1A7FA8"; CYAN_LIGHT = "FFE8F4F9"; WHITE = "FFFFFFFF"; DARK = "FF212529"
GREEN = "FF1D9E75"; RED = "FFD94F3D"; YELLOW = "FFF5A623"; AMBER_LIGHT = "FFFAEEDA"; AMBER_TEXT = "FF633806"

def hdr(ws, r, c, v, bg=CYAN, fg=WHITE):
    cell = ws.cell(row=r, column=c, value=v)
    cell.font = Font(bold=True, color=fg, size=10, name="Arial")
    cell.fill = PatternFill("solid", start_color=bg)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    return cell

def dat(ws, r, c, v, bold=False, align="left", color=None):
    cell = ws.cell(row=r, column=c, value=v)
    cell.font = Font(bold=bold, color=color or DARK, size=10, name="Arial")
    cell.alignment = Alignment(horizontal=align, vertical="center")
    return cell

def rc(rate):
    if rate >= 75: return GREEN
    if rate >= 50: return YELLOW
    return RED

def detach_color(rate):
    if rate is None: return "FF8C8880"
    if rate < 15: return GREEN
    if rate < 30: return YELLOW
    return RED

# RESUMEN
ws1 = wb.active; ws1.title = "Resumen"; ws1.sheet_view.showGridLines = False
ws1.row_dimensions[1].height = 36
t = ws1.cell(row=1, column=1, value="Dalton DS — Reporte de Adopción")
t.font = Font(bold=True, size=14, color=DARK, name="Arial")
ws1.merge_cells("A1:I1")
ws1.cell(row=2, column=1, value=f"Quarter: {report['quarter']}  |  {report['generatedAt'][:10]}").font = Font(size=9, color="FF6C757D", name="Arial")
ws1.merge_cells("A2:I2")
ws1.row_dimensions[4].height = 26
for i, h in enumerate(["Categoría","Activo","Archivos","Frames RFD","Inst. DS","Internos","Familias únicas DS","Adopción %","Detach %"], 1):
    hdr(ws1, 4, i, h)
row = 5
for team in report["teams"]:
    ws1.row_dimensions[row].height = 20
    dat(ws1, row, 1, team.get("category", team["name"]))
    dat(ws1, row, 2, team["name"], bold=True)
    dat(ws1, row, 3, len(team["files"]), align="center")
    dat(ws1, row, 4, team["totalRfdFrames"], align="center")
    dat(ws1, row, 5, team.get("dsInstances",0), align="center", color="FF1A7FA8")
    dat(ws1, row, 6, team.get("internalInstances",0), align="center")
    dat(ws1, row, 7, team.get("uniqueFamiliesCount",0), align="center", color="FF6B4FBB")
    r = team["adoptionRate"]
    dat(ws1, row, 8, f"{r}%", bold=True, align="center", color=rc(r))
    dr = team.get("detachRate")
    dat(ws1, row, 9, f"{dr}%" if dr is not None else "—", bold=True, align="center", color=detach_color(dr))
    row += 1
for col, w in zip(range(1,10), [18,24,10,12,12,12,16,12,11]):
    ws1.column_dimensions[get_column_letter(col)].width = w

# POR ARCHIVO
ws2 = wb.create_sheet("Por archivo"); ws2.sheet_view.showGridLines = False
for i, h in enumerate(["Categoría","Activo","Archivo","Frames RFD","Inst. DS","Internos","Familias únicas","Adopción %"], 1):
    hdr(ws2, 1, i, h)
row = 2
for team in report["teams"]:
    for f in team["files"]:
        dat(ws2, row, 1, team.get("category", team["name"]))
        dat(ws2, row, 2, team["name"])
        dat(ws2, row, 3, f["name"], bold=True)
        dat(ws2, row, 4, f["rfdFrameCount"], align="center")
        dat(ws2, row, 5, f.get("dsInstances",0), align="center", color="FF1A7FA8")
        dat(ws2, row, 6, f.get("internalInstances",0), align="center")
        dat(ws2, row, 7, f.get("uniqueFamiliesCount",0), align="center", color="FF6B4FBB")
        r = f["adoptionRate"]
        dat(ws2, row, 8, f"{r}%", bold=True, align="center", color=rc(r))
        row += 1
for col, w in zip(range(1,9), [18,22,30,12,12,12,14,12]):
    ws2.column_dimensions[get_column_letter(col)].width = w

# DETACH RATE
ws3a = wb.create_sheet("Detach rate"); ws3a.sheet_view.showGridLines = False
ws3a.cell(row=1, column=1, value="Detach rate por categoría — Library Analytics API").font = Font(bold=True, size=12, color=DARK, name="Arial")
ws3a.merge_cells("A1:E1")
ws3a.cell(row=2, column=1, value="Fuente: Figma Library Analytics (Enterprise). Fórmula: detachments / (detachments + insertions) del quarter actual.").font = Font(size=9, color="FF6C757D", italic=True, name="Arial")
ws3a.merge_cells("A2:E2")
for i, h in enumerate(["Categoría","Detachments","Insertions","Total acciones","Detach %"], 1):
    hdr(ws3a, 4, i, h, bg="FFBA7517")
row = 5
for team in report["teams"]:
    cat = team.get("category", team["name"])
    dr = team.get("detachRate")
    detachments = team.get("detachments")
    insertions = team.get("detachInsertions")
    if dr is None:
        continue
    # avoid duplicate categories (multiple activos share one category's detach data)
    already = any(ws3a.cell(row=r, column=1).value == cat for r in range(5, row))
    if already:
        continue
    dat(ws3a, row, 1, cat, bold=True)
    dat(ws3a, row, 2, detachments, align="center")
    dat(ws3a, row, 3, insertions, align="center")
    dat(ws3a, row, 4, (detachments or 0) + (insertions or 0), align="center")
    dat(ws3a, row, 5, f"{dr}%", bold=True, align="center", color=detach_color(dr))
    row += 1
for col, w in zip(range(1,6), [26,14,14,14,12]):
    ws3a.column_dimensions[get_column_letter(col)].width = w

# FAMILIAS ÚNICAS DS
ws3 = wb.create_sheet("Familias DS usadas"); ws3.sheet_view.showGridLines = False
for i, h in enumerate(["Categoría","Activo","Archivo","Familia DS","Instancias"], 1):
    hdr(ws3, 1, i, h)
row = 2
for team in report["teams"]:
    for f in team["files"]:
        for fam in (f.get("uniqueFamilies") or []):
            dat(ws3, row, 1, team.get("category", team["name"]))
            dat(ws3, row, 2, team["name"])
            dat(ws3, row, 3, f["name"])
            dat(ws3, row, 4, fam["name"], bold=True)
            dat(ws3, row, 5, fam["count"], align="center", color="FF1A7FA8")
            row += 1
for col, w in zip(range(1,6), [18,22,30,28,12]):
    ws3.column_dimensions[get_column_letter(col)].width = w

# COMPONENTES INTERNOS
ws4 = wb.create_sheet("Internos"); ws4.sheet_view.showGridLines = False
for i, h in enumerate(["Categoría","Activo","Componente interno","Instancias"], 1):
    hdr(ws4, 1, i, h)
row = 2
for team in report["teams"]:
    for item in (team.get("top20Internal") or []):
        dat(ws4, row, 1, team.get("category", team["name"]))
        dat(ws4, row, 2, team["name"])
        dat(ws4, row, 3, item["name"])
        dat(ws4, row, 4, item["count"], align="center", bold=True)
        row += 1
for col, w in zip(range(1,5), [18,22,36,14]):
    ws4.column_dimensions[get_column_letter(col)].width = w

# HISTORIAL
ws5 = wb.create_sheet("Historial"); ws5.sheet_view.showGridLines = False
for i, h in enumerate(["Equipo","Categoría","Quarter","Fecha","Adopción %","Detach %","Frames RFD","Inst. DS","Total"], 1):
    hdr(ws5, 1, i, h)
row = 2
for entry in sorted(report.get("history",[]), key=lambda x: (x["team"], x["quarter"])):
    dat(ws5, row, 1, entry["team"], bold=True)
    dat(ws5, row, 2, entry.get("category",""))
    dat(ws5, row, 3, entry["quarter"], align="center")
    dat(ws5, row, 4, entry.get("date",""))
    r = entry["adoptionRate"]
    dat(ws5, row, 5, f"{r}%", bold=True, align="center", color=rc(r))
    dr = entry.get("detachRate")
    dat(ws5, row, 6, f"{dr}%" if dr is not None else "—", bold=True, align="center", color=detach_color(dr))
    dat(ws5, row, 7, entry.get("totalRfdFrames",0), align="center")
    dat(ws5, row, 8, entry.get("totalDs",0), align="center", color="FF1A7FA8")
    dat(ws5, row, 9, entry.get("totalInstances",0), align="center")
    row += 1
for col, w in zip(range(1,10), [24,18,12,14,12,11,12,12,12]):
    ws5.column_dimensions[get_column_letter(col)].width = w

wb.save("${outputPath}")
print("Excel saved")
`;
  fs.writeFileSync(tmpScript, script);
  try {
    execSync(`python3 ${tmpScript}`, { stdio: 'inherit' });
  } catch(e) {
    console.error("Excel generation failed:", e.message);
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
        filesData.push({ key: file.key, name: file.name, error: e.message, rfdFrameCount: 0, dsInstances: 0, internalInstances: 0, totalInstances: 0, adoptionRate: 0, uniqueFamiliesCount: 0, uniqueFamilies: [], top20Internal: [] });
      }
      await sleep(1500);
    }

    const totalRfdFrames = filesData.reduce((s, f) => s + f.rfdFrameCount, 0);
    const totalDs = filesData.reduce((s, f) => s + f.dsInstances, 0);
    const totalInternal = filesData.reduce((s, f) => s + f.internalInstances, 0);
    const totalInstances = totalDs + totalInternal;
    const teamAdoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;

    const familyMap = {};
    for (const f of filesData) {
      for (const fam of (f.uniqueFamilies || [])) {
        familyMap[fam.name] = (familyMap[fam.name] || 0) + fam.count;
      }
    }
    const teamUniqueFamilies = Object.entries(familyMap).sort((a,b) => b[1]-a[1]).map(([name,count]) => ({name,count}));

    const aggregatedInternal = {};
    for (const f of filesData) {
      for (const { name, count } of (f.top20Internal || [])) {
        aggregatedInternal[name] = (aggregatedInternal[name] || 0) + count;
      }
    }
    const teamTop20Internal = Object.entries(aggregatedInternal).sort((a,b) => b[1]-a[1]).slice(0,20).map(([name,count]) => ({name,count}));

    teamsData.push({
      name: team.name, category: team.category || team.name,
      adoptionRate: teamAdoptionRate,
      totalRfdFrames, dsInstances: totalDs, internalInstances: totalInternal, totalInstances,
      uniqueFamiliesCount: teamUniqueFamilies.length,
      uniqueFamilies: teamUniqueFamilies,
      top20Internal: teamTop20Internal, files: filesData,
    });
  }

  // --- DETACH RATE: fetch and attach to each team by category ---
  const detachByCategory = await getDetachRateByCategory();
  for (const team of teamsData) {
    const detach = detachByCategory[team.category];
    if (detach) {
      team.detachRate = detach.detachRate;
      team.detachments = detach.detachments;
      team.detachInsertions = detach.insertions;
    } else {
      team.detachRate = null;
      team.detachments = null;
      team.detachInsertions = null;
    }
  }

  const now = new Date();
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const dateStr = now.toISOString().split("T")[0];

  for (const team of teamsData) {
    const existingIdx = history.findIndex(h => h.team === team.name && h.quarter === quarter);
    const entry = {
      team: team.name, category: team.category, quarter, date: dateStr,
      adoptionRate: team.adoptionRate,
      totalRfdFrames: team.totalRfdFrames,
      totalDs: team.dsInstances,
      totalInstances: team.totalInstances,
      detachRate: team.detachRate,
      detachments: team.detachments,
    };
    if (existingIdx >= 0) { history[existingIdx] = entry; } else { history.push(entry); }
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  const report = { generatedAt: now.toISOString(), quarter, teams: teamsData, history };
  if (!fs.existsSync(path.join(__dirname, "docs"))) fs.mkdirSync(path.join(__dirname, "docs"));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const excelPath = path.join(__dirname, "docs", "reporte-adopcion.xlsx");
  generateExcel(report, excelPath);

  console.log(`\nReport saved to docs/report.json`);
  console.log("\n=== Summary ===");
  for (const team of teamsData) {
    const dr = team.detachRate !== null ? `${team.detachRate}%` : "N/A";
    console.log(`[${team.category}] ${team.name}: Adoption ${team.adoptionRate}% | Detach ${dr} | ${team.totalRfdFrames} RFD | ${team.uniqueFamiliesCount} familias únicas`);
  }

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
  console.log(`Total únicos: ${sorted.length}`);
}

run().catch(e => { console.error("Fatal error:", e); process.exit(1); });
