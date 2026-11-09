import "dotenv/config";

async function checkGroqModels() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return console.log("GROQ_API_KEY not set");

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) return console.log(`Groq models error: ${res.status}`);
    const data = await res.json();
    const models = (data.data || [])
      .filter((m: any) => m.active)
      .map((m: any) => m.id)
      .sort();
    console.log("Active Groq models:", models.join("\n  "));
  } catch (e) {
    console.log("Groq models fetch failed:", (e as Error).message);
  }
}

async function checkGeminiModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return console.log("GEMINI_API_KEY not set");

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (!res.ok) return console.log(`Gemini models error: ${res.status}`);
    const data = await res.json();
    const models = (data.models || [])
      .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: any) => m.name.replace("models/", ""))
      .sort();
    console.log("Active Gemini models:", models.join("\n  "));
  } catch (e) {
    console.log("Gemini models fetch failed:", (e as Error).message);
  }
}

checkGroqModels();
checkGeminiModels();
