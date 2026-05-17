const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors({
  origin: ['https://reponse-avis-google.vercel.app', 'http://localhost:3000']
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ReplyGoogle API en ligne ✅' });
});

app.post('/generate', async (req, res) => {
  const { review, businessName, businessType, stars, tone, customInstructions } = req.body;

  if (!review || !businessName) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

const prompt = `Tu es le gerant de "${businessName}", un(e) ${businessType || 'etablissement'}. Reponds a cet avis Google ${stars || 5} etoile(s) de facon ${tone || 'Chaleureux'}.
Regles STRICTES :
- Maximum 2 phrases courtes
- Ton naturel et humain
- Zero emoji, zero markdown, zero gras
- Pas de superlatifs exageres
- Avis positif : remercier simplement, mentionner un detail de l'avis, terminer par le nom
- Avis negatif : reconnaitre le probleme specifique, dire qu'on prend note et qu'on va s'ameliorer, NE PAS proposer de discussion privee, NE PAS inviter a rappeler ou recontacter, terminer par le nom
- INTERDIT : "n'hesitez pas a nous contacter", "discutons en prive", "appelez-nous", "revenez nous voir pour qu'on arrange ca"
- La reponse doit etre complete et fermee, elle ne doit rien promettre qui necessite une action supplementaire
- Terminer par le nom de l'etablissement en texte simple
Avis : "${review}"
Reponds uniquement avec la reponse en texte brut.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.content.map(i => i.text || '').join('');
    res.json({ response: text });

  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`ReplyGoogle API démarrée sur le port ${PORT}`);
});
