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
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(__dirname, "../public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

const MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
let globalChunks = [];

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

function relevantChunks(q, chunks, max = 4) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  if (!terms.length || !chunks.length) return [];
  return chunks
    .map(c => ({ c, s: terms.reduce((a, t) => a + (c.toLowerCase().match(new RegExp(t, "g")) || []).length, 0) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, max).map(x => x.c);
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
Sé fiel al texto original. No agregues información extra. Organiza por secciones si las hay.`
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

Sé específico. En español.`
    );

    res.json({ resumen, charCount: allText.length, totalChunks: globalChunks.length });
  } catch (err) {
    console.error("❌ upload-pages:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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

app.post("/api/clear-notes", (_, res) => { globalChunks = []; res.json({ ok: true }); });
app.get("/api/health", (_, res) => res.json({ ok: true, model: MODEL, chunks: globalChunks.length }));

app.post("/api/flashcards", async (req, res) => {
  const { drug } = req.body;
  if (!drug) return res.status(400).json({ error: "Fármaco requerido" });
  try {
    const chunks = relevantChunks(drug, globalChunks, 6);
    const hasNotes = chunks.length > 0;
    const ctx = hasNotes
      ? `\n\nAPUNTES DE LA ESTUDIANTE (úsalos como fuente primaria y cítalos textualmente en notaApuntes):\n${chunks.join("\n---\n")}`
      : "";

    const raw = await groq(
      "Eres farmacólogo clínico experto. Respondes en español con JSON puro válido, sin markdown, sin texto antes ni después del JSON.",
      `Genera información farmacológica DETALLADA y COMPLETA sobre: ${drug}${ctx}

INSTRUCCIONES IMPORTANTES:
- El contenido de cada card debe ser extenso y clínico (mínimo 3-4 oraciones por card)
- Si hay apuntes de la estudiante: INTÉGRALOS en el contenido y pon enApuntes=true con la cita textual en notaApuntes
- Si no hay apuntes: usa tu conocimiento farmacológico completo (Goodman & Gilman, Katzung)
- Sé específico: menciona nombres de enzimas, receptores, vías, porcentajes, tiempos

Responde ÚNICAMENTE con este JSON sin texto extra ni backticks:
{"nombre":"nombre oficial completo","familia":"grupo farmacológico detallado","cards":[
{"titulo":"Mecanismo de Acción","icono":"⚙️","color":"teal","contenido":"mecanismo molecular muy detallado con receptores, enzimas y vías involucradas","enApuntes":false,"notaApuntes":""},
{"titulo":"Espectro / Clasificación","icono":"🔭","color":"purple","contenido":"clasificación completa y espectro de actividad detallado","enApuntes":false,"notaApuntes":""},
{"titulo":"Indicaciones Clínicas","icono":"✅","color":"gold","contenido":"todas las indicaciones aprobadas con contexto clínico","enApuntes":false,"notaApuntes":""},
{"titulo":"Contraindicaciones","icono":"🚫","color":"red","contenido":"contraindicaciones absolutas y relativas con justificación clínica","enApuntes":false,"notaApuntes":""},
{"titulo":"Interacciones Farmacológicas","icono":"⚡","color":"purple","contenido":"interacciones relevantes con mecanismo de cada una","enApuntes":false,"notaApuntes":""},
{"titulo":"Reacciones Adversas (RAM)","icono":"⚠️","color":"gold","contenido":"efectos adversos organizados por frecuencia y severidad","enApuntes":false,"notaApuntes":""},
{"titulo":"Farmacocinética (ADME)","icono":"📊","color":"teal","contenido":"ADME completo con biodisponibilidad, Vd, unión proteínas, metabolismo CYP, t½, eliminación","enApuntes":false,"notaApuntes":""},
{"titulo":"Dosis y Presentaciones","icono":"💊","color":"gold","contenido":"dosis exactas en adultos, ajustes especiales y presentaciones disponibles","enApuntes":false,"notaApuntes":""}
]}`, 0.35
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
// QUIZ — por lotes, con instrucción estricta anti-repetición
// ─────────────────────────────────────────────
app.post("/api/quiz", async (req, res) => {
  const { drugs, count = 10, difficulty = "intermedia", type = "mixto" } = req.body;
  if (!drugs) return res.status(400).json({ error: "Medicamentos requeridos" });

  const total = Math.min(parseInt(count) || 10, 20);
  const BATCH = 5;

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

      // Construir lista de enunciados ya generados para evitar repetición
      const prevEnunciados = allQuestions.length > 0
        ? `\nPREGUNTAS YA GENERADAS (NO repitas ni parafrasees ninguna de estas):\n${allQuestions.map((q,i) => `${i+1}. ${q.pregunta}`).join("\n")}\n`
        : "";

      console.log(`  Quiz lote ${b+1}/${batches}: ${batchSize} preguntas...`);

      const raw = await groq(
        "Eres docente experto en farmacología clínica. Generas preguntas de examen de alta calidad en español. Respondes SOLO con JSON array válido y COMPLETO, sin texto adicional, sin markdown.",
        `Genera EXACTAMENTE ${batchSize} preguntas de opción múltiple sobre: ${drugs}
Dificultad: ${diffs[difficulty]}
Tipo: ${types[type]}${ctx}
${prevEnunciados}
REGLAS OBLIGATORIAS:
- NUNCA repitas una pregunta ni hagas una similar o parafraseada a las ya generadas
- Cada pregunta debe evaluar un aspecto DIFERENTE del medicamento (no repitas el mismo concepto)
- Las ${batchSize} preguntas deben ser completamente únicas entre sí
- Para dificultad avanzada: incluye caso clínico completo en el enunciado (paciente con edad, sexo, síntomas, antecedentes relevantes, resultados de laboratorio si aplica)
- Las opciones deben ser plausibles y los distractores bien elaborados
- La explicación debe ser educativa y mencionar el mecanismo farmacológico

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
        const last = m[0].lastIndexOf("},");
        if (last > 5) {
          try { batch = JSON.parse(m[0].slice(0, last + 1) + "]"); }
          catch { console.log("  lote irreparable, continuando..."); continue; }
        } else continue;
      }

      if (Array.isArray(batch)) {
        // Deduplicar contra lo ya acumulado (por si el modelo ignoró la instrucción)
        const prevTexts = allQuestions.map(q => q.pregunta.slice(0, 60).toLowerCase());
        const filtered = batch.filter(q =>
          !prevTexts.some(p => q.pregunta.slice(0, 60).toLowerCase().includes(p.slice(0, 40)) || p.includes(q.pregunta.slice(0, 40).toLowerCase()))
        );
        allQuestions.push(...filtered);
      }
    }

    if (!allQuestions.length) throw new Error("No se generaron preguntas. Intenta de nuevo.");
    res.json(allQuestions.slice(0, total));

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