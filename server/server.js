import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import axios from "axios";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "60mb" }));  // grande para recibir imágenes base64
app.use(express.static(path.join(__dirname, "../public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

const MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
let globalChunks = [];

// ── multer solo para imágenes directas ──
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => {
      const d = path.join(__dirname, "../uploads");
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      cb(null, d);
    },
    filename: (_, f, cb) => cb(null, Date.now() + "-" + f.originalname)
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function chunk(text, size = 700) {
  const w = text.split(/\s+/);
  const out = [];
  for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size).join(" "));
  return out;
}

function relevantChunks(q, chunks, max = 6) {
  if (!chunks.length) return [];

  // Generar términos de búsqueda: nombre completo + partes individuales + prefijos de 4+ chars
  const qLower = q.toLowerCase();
  const terms = new Set();
  terms.add(qLower); // nombre completo
  qLower.split(/[\s,\/\-]+/).forEach(t => { if (t.length >= 3) terms.add(t); });
  // Prefijos de 5+ chars (ej: "metron" encuentra "metronidazol")
  [...terms].forEach(t => { if (t.length >= 6) terms.add(t.slice(0, 5)); });

  const termArr = [...terms];

  return chunks
    .map(c => {
      const cLow = c.toLowerCase();
      let score = 0;
      for (const t of termArr) {
        const matches = (cLow.match(new RegExp(t, "g")) || []).length;
        // Nombre completo vale más
        score += matches * (t === qLower ? 3 : 1);
      }
      return { c, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.c);
}

async function groq(system, user, temp = 0.35) {
  const r = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: temp, max_tokens: 4096
  }, {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    timeout: 90000
  });
  return r.data.choices[0].message.content;
}

async function groqVision(base64, mime, prompt) {
  const r = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
    model: MODEL,
    messages: [{
      role: "user", content: [
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        { type: "text", text: prompt }
      ]
    }],
    temperature: 0.1, max_tokens: 4096
  }, {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    timeout: 90000
  });
  return r.data.choices[0].message.content;
}

// ─────────────────────────────────────────────
// ENDPOINT: recibe páginas ya convertidas a imagen por el frontend
// body: { pages: [{base64, mime, pageNum}], filename }
// ─────────────────────────────────────────────
app.post("/api/upload-pages", async (req, res) => {
  const { pages, filename } = req.body;
  if (!pages?.length) return res.status(400).json({ error: "No se recibieron páginas." });
  console.log(`📥 upload-pages: ${pages.length} págs de "${filename}"`);

  try {
    let allText = "";
    for (const p of pages) {
      console.log(`  OCR pág ${p.pageNum}...`);
      const txt = await groqVision(p.base64, p.mime,
        `Eres experto en OCR de apuntes médicos en español.
Transcribe TODO el texto visible en esta imagen de apuntes universitarios de farmacología.
Incluye: nombres de fármacos, mecanismos de acción, indicaciones, contraindicaciones, RAM, dosis, clasificaciones, flechas explicativas, tablas, notas al margen.
S  fiel al texto original. No agregues información extra. Organiza por secciones si las hay.`
      );
      allText += `\n--- Página ${p.pageNum} ---\n${txt}\n`;
      console.log(`  pág ${p.pageNum} OK: ${txt.length} chars`);
    }

    if (allText.trim().length < 50) {
      return res.status(400).json({ error: "No se pudo extraer texto de las páginas." });
    }

    globalChunks.push(...chunk(allText, 700));
    console.log(`  Chunks totales: ${globalChunks.length}`);

    const resumen = await groq(
      "Eres experto en farmacología clínica. Analizas apuntes universitarios. Respondes en español.",
      `Analiza estos apuntes de farmacología (transcritos de apuntes manuscritos por OCR) y genera un resumen estructurado con HTML limpio usando solo: <h4>, <strong>, <ul>, <li>, <p>

APUNTES:
${allText.slice(0, 6000)}

Estructura exacta:
<h4>💊 Medicamentos y fármacos mencionados</h4>
<ul><li><strong>Fármaco</strong>: contexto/uso en los apuntes</li></ul>

<h4>🔬 Conceptos farmacológicos clave</h4>
<ul><li><strong>Concepto</strong>: descripción de los apuntes</li></ul>

<h4>📌 Puntos importantes para el examen</h4>
<ul><li>punto específico extraído de los apuntes</li></ul>

S  específico. En español.`
    );

    res.json({ resumen, charCount: allText.length, totalChunks: globalChunks.length });
  } catch (err) {
    console.error("❌ upload-pages:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: imagen JPG/PNG directa
// ─────────────────────────────────────────────
app.post("/api/upload-image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió imagen." });
  console.log(`🖼 upload-image: ${req.file.originalname}`);
  try {
    const buf = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);
    const b64 = buf.toString("base64");
    const txt = await groqVision(b64, req.file.mimetype,
      "Transcribe TODO el texto de estos apuntes médicos/farmacológicos. Fármacos, mecanismos, dosis, RAM, indicaciones. Fiel al texto original."
    );
    globalChunks.push(...chunk(txt, 700));
    const resumen = await groq(
      "Eres experto en farmacología. Respondes en español con HTML limpio.",
      `Analiza OCR de apuntes. Usa <h4>, <strong>, <ul>, <li>, <p>:\n\n${txt.slice(0, 5000)}\n\nMedicamentos, conceptos clave, puntos de examen.`
    );
    res.json({ resumen, charCount: txt.length, totalChunks: globalChunks.length });
  } catch (err) {
    console.error("❌ upload-image:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: texto plano / TXT
// ─────────────────────────────────────────────
app.post("/api/analyze-text", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "Texto vacío" });
  globalChunks.push(...chunk(text, 700));
  try {
    const resumen = await groq(
      "Eres experto en farmacología. En español con HTML limpio.",
      `Analiza apuntes con <h4>, <strong>, <ul>, <li>, <p>:\n\n${text.slice(0, 6000)}\n\nMedicamentos, conceptos, puntos de examen.`
    );
    res.json({ resumen, charCount: text.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
app.post("/api/clear-notes", (_, res) => { globalChunks = []; res.json({ ok: true }); });
app.get("/api/health", (_, res) => res.json({ ok: true, model: MODEL, chunks: globalChunks.length }));

// ─────────────────────────────────────────────
// FLASHCARDS
// ─────────────────────────────────────────────
app.post("/api/flashcards", async (req, res) => {
  const { drug } = req.body;
  if (!drug) return res.status(400).json({ error: "Fármaco requerido" });
  try {
    // Buscar chunks específicos del medicamento
    let chunks = relevantChunks(drug, globalChunks, 6);

    // Si no encontró nada específico, buscar por grupo (ej: si busca "Metronidazol" buscar "nitroimidazol")
    if (chunks.length === 0 && globalChunks.length > 0) {
      chunks = globalChunks.slice(0, 4); // tomar los primeros chunks como contexto general
    }

    const hasNotes = chunks.length > 0;
    const notesBlock = hasNotes
      ? `\n\n═══ APUNTES DE LA ESTUDIANTE ═══\n${chunks.join("\n\n---\n\n")}\n═══════════════════════════════`
      : "";

    const raw = await groq(
      "Eres farmacólogo clínico experto. Respondes en español con JSON puro válido, sin markdown, sin texto antes ni después del JSON.",
      `Genera información farmacológica sobre: ${drug}

${hasNotes ? `⚠️ PRIORIDAD MÁXIMA: Los apuntes de la estudiante están abajo. DEBES:
1. Leer los apuntes y extraer TODO lo que dicen sobre ${drug} o su grupo farmacológico
2. En cada card, integrar lo que dicen los apuntes + complementar con tu conocimiento
3. Si los apuntes mencionan algo específico sobre esta tarjeta: enApuntes=true, notaApuntes=cita textual del apunte
4. El contenido debe reflejar principalmente LO QUE ESTÁ EN LOS APUNTES, no solo conocimiento general` :
`No hay apuntes disponibles. Usa tu conocimiento completo de Goodman & Gilman y Katzung.`}

Responde ÚNICAMENTE con este JSON sin texto extra:
{"nombre":"nombre oficial","familia":"grupo farmacológico","cards":[
{"titulo":"Mecanismo de Acción","icono":"⚙️","color":"teal","contenido":"mecanismo detallado integrando apuntes + conocimiento","enApuntes":false,"notaApuntes":""},
{"titulo":"Espectro / Clasificación","icono":"🔭","color":"purple","contenido":"clasificación y espectro completo","enApuntes":false,"notaApuntes":""},
{"titulo":"Indicaciones Clínicas","icono":"✅","color":"gold","contenido":"indicaciones con contexto clínico","enApuntes":false,"notaApuntes":""},
{"titulo":"Contraindicaciones","icono":"🚫","color":"red","contenido":"contraindicaciones absolutas y relativas","enApuntes":false,"notaApuntes":""},
{"titulo":"Interacciones Farmacológicas","icono":"⚡","color":"purple","contenido":"interacciones relevantes con mecanismo","enApuntes":false,"notaApuntes":""},
{"titulo":"Reacciones Adversas (RAM)","icono":"⚠️","color":"gold","contenido":"efectos adversos por frecuencia y severidad","enApuntes":false,"notaApuntes":""},
{"titulo":"Farmacocinética (ADME)","icono":"📊","color":"teal","contenido":"ADME con biodisponibilidad, Vd, unión proteínas, t½, eliminación","enApuntes":false,"notaApuntes":""},
{"titulo":"Dosis y Presentaciones","icono":"💊","color":"gold","contenido":"dosis adultos y presentaciones disponibles","enApuntes":false,"notaApuntes":""}
]}${notesBlock}`, 0.3
    );
    const m = raw.replace(/```json|```/g,"").trim().match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Respuesta no válida. Intenta de nuevo.");
    res.json(JSON.parse(m[0]));
  } catch (err) {
    console.error("❌ flashcards:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────
// QUIZ — por lotes para soportar hasta 20 preguntas
// ─────────────────────────────────────────────
app.post("/api/quiz", async (req, res) => {
  const { drugs, count = 10, difficulty = "intermedia", type = "mixto" } = req.body;
  if (!drugs) return res.status(400).json({ error: "Medicamentos requeridos" });

  const total = Math.min(parseInt(count) || 10, 20);
  const BATCH = 5; // generamos de 5 en 5 para evitar truncamiento

  const chunks = relevantChunks(drugs, globalChunks, 3);
  const ctx = chunks.length ? `\nApuntes de la estudiante:\n${chunks.join("\n").slice(0, 1000)}` : "";

  const diffs = {
    basica:     "básico: preguntas directas sobre definiciones y conceptos fundamentales",
    intermedia: "intermedio: aplicación clínica, mecanismos de acción detallados y farmacocinética",
    avanzada:   "avanzado estilo MIR/USMLE: casos clínicos complejos con paciente (edad, sexo, síntomas, antecedentes), diagnóstico diferencial y razonamiento terapéutico complejo"
  };
  const types = {
    mixto:         "variadas (mecanismo de acción, indicaciones, RAM, interacciones, farmacocinética, dosis)",
    mecanismo:     "exclusivamente sobre mecanismos de acción moleculares y targets farmacológicos",
    clinico:       "casos clínicos completos con presentación de paciente y toma de decisiones terapéuticas",
    interacciones: "interacciones farmacológicas, reacciones adversas graves y toxicología"
  };

  try {
    const allQuestions = [];
    const batches = Math.ceil(total / BATCH);

    for (let b = 0; b < batches; b++) {
      const batchSize = Math.min(BATCH, total - allQuestions.length);
      if (batchSize <= 0) break;

      console.log(`  Quiz lote ${b+1}/${batches}: ${batchSize} preguntas...`);

      const raw = await groq(
        "Eres docente experto en farmacología clínica. Generas preguntas de examen de alta calidad en español. Respondes SOLO con JSON array válido y COMPLETO, sin texto adicional, sin markdown.",
        `Genera EXACTAMENTE ${batchSize} preguntas de opción múltiple sobre: ${drugs}
Dificultad: ${diffs[difficulty]}
Tipo: ${types[type]}${ctx}

Para dificultad avanzada: incluye caso clínico completo en el enunciado (paciente con edad, sexo, síntomas, antecedentes relevantes, resultados de laboratorio si aplica).
Las opciones deben ser plausibles y el distractores bien elaborados.
La explicación debe ser educativa y mencionar el mecanismo farmacológico.

Responde SOLO con el array JSON sin texto antes ni después:
[{"pregunta":"enunciado completo y detallado","fuente":"Goodman & Gilman 14a Ed. / Katzung 15a Ed. / Rang & Dale 9a Ed.","opciones":["opción A completa","opción B completa","opción C completa","opción D completa"],"respuesta":0,"explicacion":"explicación detallada del mecanismo y por qué las otras opciones son incorrectas"}]

CRÍTICO: JSON debe estar COMPLETO y ser válido. Cierra TODOS los corchetes y llaves.`, 0.5
      );

      const clean = raw.replace(/```json|```/g, "").trim();
      const m = clean.match(/\[[\s\S]*\]/);
      if (!m) { console.log("  lote sin JSON, continuando..."); continue; }

      let batch;
      try {
        batch = JSON.parse(m[0]);
      } catch {
        // Reparar JSON truncado
        const last = m[0].lastIndexOf("},");
        if (last > 5) {
          try { batch = JSON.parse(m[0].slice(0, last + 1) + "]"); }
          catch { console.log("  lote irreparable, continuando..."); continue; }
        } else continue;
      }

      if (Array.isArray(batch)) allQuestions.push(...batch);
    }

    if (!allQuestions.length) throw new Error("No se generaron preguntas. Intenta de nuevo.");
    res.json(allQuestions);

  } catch (err) {
    console.error("❌ quiz:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 PharmaChem → http://localhost:${PORT}`);
  console.log(`🤖 ${MODEL}`);
  console.log(`🔑 Groq: ${process.env.GROQ_API_KEY ? "✅" : "❌ falta GROQ_API_KEY"}\n`);
});