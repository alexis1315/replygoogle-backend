const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = 'https://xurpvafngahgasehpnmm.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://replygoogle.fr/app.html';

app.use(cors({
  origin: ['https://replygoogle.fr', 'https://www.replygoogle.fr', 'https://reponse-avis-google.vercel.app', 'http://localhost:3000']
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ReplyGoogle API en ligne ✅' });
});

// ============ GOOGLE OAUTH ============

// Étape 1 : Rediriger vers Google pour connexion
app.get('/auth/google', (req, res) => {
  const userId = req.query.userId;
  const scopes = [
    'https://www.googleapis.com/auth/business.manage'
  ].join(' ');

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    state: userId // On passe le userId pour le retrouver au callback
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Étape 2 : Callback Google → échanger le code contre un token
app.post('/auth/google/callback', async (req, res) => {
  const { code, userId } = req.body;
  if (!code || !userId) return res.status(400).json({ error: 'Paramètres manquants' });

  try {
    // Échanger le code contre des tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenRes.json();
    if (tokens.error) return res.status(400).json({ error: tokens.error_description });

    // Sauvegarder les tokens dans Supabase
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
        google_access_token: tokens.access_token,
        google_refresh_token: tokens.refresh_token,
        google_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      })
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de l\'échange du token' });
  }
});

// Étape 3 : Récupérer les avis Google d'un établissement
app.get('/google/reviews', async (req, res) => {
  const { userId, locationId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId manquant' });

  try {
    // Récupérer le token depuis Supabase
    const prefRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${userId}&select=google_access_token,google_refresh_token,google_token_expires_at`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    const prefs = await prefRes.json();
    if (!prefs[0]?.google_access_token) return res.status(401).json({ error: 'Compte Google non connecté' });

    let accessToken = prefs[0].google_access_token;

    // Rafraîchir le token si expiré
    const expiresAt = new Date(prefs[0].google_token_expires_at);
    if (expiresAt < new Date()) {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: prefs[0].google_refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const refreshed = await refreshRes.json();
      accessToken = refreshed.access_token;

      // Mettre à jour le token dans Supabase
      await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          google_access_token: accessToken,
          google_token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        })
      });
    }

    // Récupérer les établissements Google Business
    const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const accounts = await accountsRes.json();
    if (!accounts.accounts?.length) return res.json({ reviews: [], accounts: [] });

    const accountName = accounts.accounts[0].name;

    // Récupérer les établissements
    const locationsRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const locations = await locationsRes.json();

    // Si un locationId est spécifié, récupérer ses avis
    if (locationId) {
      const reviewsRes = await fetch(`https://mybusiness.googleapis.com/v4/${locationId}/reviews`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const reviewsData = await reviewsRes.json();
      return res.json({ reviews: reviewsData.reviews || [], locations: locations.locations || [] });
    }

    res.json({ reviews: [], locations: locations.locations || [], accounts: accounts.accounts });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la récupération des avis' });
  }
});

// ============ STRIPE WEBHOOK ============
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

// ============ GÉNÉRATION IA ============
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
