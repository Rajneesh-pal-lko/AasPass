const axios = require('axios');

const BASE_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const headers = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json',
});

async function sendMessage(to, payload) {
  const body = { messaging_product: 'whatsapp', to, ...payload };
  try {
    const res = await axios.post(BASE_URL, body, { headers: headers() });
    return res.data;
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data || err.message);
    throw err;
  }
}

// Plain text
function sendText(to, text) {
  return sendMessage(to, { type: 'text', text: { body: text } });
}

// Button message (up to 3 reply buttons)
function sendButtons(to, bodyText, buttons) {
  return sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

// List message (up to 10 rows across sections)
function sendList(to, bodyText, buttonLabel, sections) {
  return sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections,
      },
    },
  });
}

// CTA URL button
function sendCTAButton(to, bodyText, buttonText, url) {
  return sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: bodyText },
      action: {
        name: 'cta_url',
        parameters: { display_text: buttonText, url },
      },
    },
  });
}

// Location request
function sendLocationRequest(to, bodyText) {
  return sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: bodyText },
      action: { name: 'send_location' },
    },
  });
}

module.exports = { sendText, sendButtons, sendList, sendCTAButton, sendLocationRequest };
