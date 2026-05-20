const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = 'https://xurpvafngahgasehpnmm.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

app.use(cors({
  origin: ['https://reponse-avis-google.vercel.app', 'http://localhost:3000']
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ReplyGoogle API en ligne ✅' });
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    const subscription = event.data.object;
    const customerId = subscription.customer;
    const status = subscription.status;
    const priceId = subscription.items?.data[0]?.price?.id;

    let plan = 'free';
    if (status === 'active') {
      if (priceId === 'price_1TWzT49WVy70N8CXKhHkssA3') plan = 'starter';
      else if (priceId === 'price_1TY7hk9WVy70N8CX0G6XQKiX') plan = 'pro';
      else if (priceId === 'price_1TY7iF9WVy70N8CXzWV8HDrW') plan = 'agence';
      else plan = 'starter';
    }
    if (event.type === 'customer.subscription.deleted') plan = 'free';

    let userId = subscription.metadata?.supabase_user_id;

    if (!userId) {
      const customer = await stripe.customers.retrieve(customerId);
      userId = customer.metadata?.supabase_user_id;

      if (!userId && customer.email) {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(customer.email)}`, {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        });
        const userData = await userRes.json();
        userId = userData?.users?.[0]?.id;
      }
    }

    if (userId) {
      await fetch(`${SUPABASE_URL}/rest/v1/user_preferences`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          user_id: userId,
          stripe_customer_id: customerId,
          plan,
          plan_updated_at: new Date().toISOString()
        })
      });
    }

  } catch (err) {
    console.log('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.json({ received: true });
});

app.post('/generate', async (req, res) => {
  const { review, businessName, businessType, stars, tone, customInstructions, language } = req.body;
  if (!review || !businessName) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }
  const lang = language || 'Français';
  const prompt = `Tu es le gerant de "${businessName}", un(e) ${businessType || 'etablissement'}. Reponds a cet avis Google ${stars || 5} etoile(s) de facon ${tone || 'Chaleureux'}.
${customInstructions ? `INSTRUCTIONS PRIORITAIRES DU PROPRIETAIRE (a respecter absolument si raisonnable) : ${customInstructions}` : ''}
LANGUE DE LA REPONSE : Tu dois repondre UNIQUEMENT en ${lang}. Peu importe la langue de l'avis, ta reponse doit etre en ${lang}.
Regles de base (sauf si les instructions du proprietaire disent autrement) :
- Maximum 2 phrases courtes
- Ton naturel et humain
- Zero emoji, zero markdown, zero gras
- Pas de superlatifs exageres
- Avis positif : remercier simplement, mentionner un detail de l'avis, terminer par le nom
- Avis negatif : reconnaitre le probleme specifique, dire qu'on prend note et qu'on va s'ameliorer, NE PAS proposer de discussion privee, NE PAS inviter a rappeler ou recontacter, terminer par le nom
- INTERDIT : "n'hesitez pas a nous contacter", "discutons en prive", "appelez-nous"
- La reponse ne doit rien promettre qui necessite une action du proprietaire
- Terminer par le nom de l'etablissement en texte simple
Avis : "${review}"
Reponds avec un JSON valide uniquement, sans backticks, sans markdown, avec ce format exact :
{"response":"la reponse ici","explanation":"${customInstructions ? 'explication courte en francais de comment tu as applique ou adapte les instructions' : ''}"}`;

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
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const raw = data.content.map(i => i.text || '').join('');
    try {
      const parsed = JSON.parse(raw);
      res.json({ response: parsed.response, explanation: parsed.explanation });
    } catch {
      res.json({ response: raw, explanation: '' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`ReplyGoogle API démarrée sur le port ${PORT}`);
});
