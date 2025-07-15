// send-sms.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    console.log(`✅ SMS sent to ${to}: ${message}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send SMS to ${to}:`, err.message);
    return false;
  }
}

async function notifyAndMark(entry, message) {
  const smsSent = await sendSMS(entry.phone_number, message);
  if (smsSent) {
    const { error } = await supabase
      .from('queue_entries')
      .update({ notified: true })
      .eq('id', entry.id);
    if (error) console.error(`❌ Could not mark entry as notified:`, error.message);
  }
}

async function notifyCustomers() {
  const { data: entries, error: queueError } = await supabase
    .from('queue_entries')
    .select('*')
    .eq('status', 'waiting')
    .eq('notified', false)
    .order('joined_at', { ascending: true });

  if (queueError || !entries) return console.error('❌ Error fetching queue:', queueError?.message);

  const { data: barbers, error: barberError } = await supabase
    .from('barbers')
    .select('id')
    .eq('status', 'active');

  if (barberError || !barbers) return console.error('❌ Error fetching barbers:', barberError?.message);

  const activeBarberCount = barbers.length;
  const { data: shops, error: shopError } = await supabase
    .from('barbershops')
    .select('id, notify_threshold');

  if (shopError || !shops) return console.error('❌ Error fetching shops:', shopError?.message);

  const shopMap = Object.fromEntries(shops.map(s => [s.id, s]));
  const queuesByShop = {};

  for (const entry of entries) {
    const shopId = entry.shop_id;
    if (!queuesByShop[shopId]) queuesByShop[shopId] = [];
    queuesByShop[shopId].push(entry);
  }

  for (const shopId in queuesByShop) {
    const queue = queuesByShop[shopId];
    const shop = shopMap[shopId];

    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (entry.requested_barber_id) {
        const isNext = !queue.slice(0, i).some(e => e.requested_barber_id === entry.requested_barber_id);
        if (isNext) {
          console.log(`📢 Notifying ${entry.customer_name} for specific barber.`);
          await notifyAndMark(entry, `You're next in line for your barber at Fade Lab!`);
        }
      } else {
        const unassignedAhead = queue.slice(0, i).filter(e => !e.requested_barber_id);
        const notifyIndex = Math.max(activeBarberCount - 1, 0); // notify if you're index X where X = activeBarbers - 1
        if (unassignedAhead.length === notifyIndex) {
          console.log(`📢 Notifying ${entry.customer_name} (Any barber) — position ${i} with ${activeBarberCount} active barbers.`);
          await notifyAndMark(entry, `You're almost up at Fade Lab – get ready!`);
        }
      }
    }
  }
}

(async () => {
  try {
    await notifyCustomers();
    process.exit(0);
  } catch (err) {
    console.error('💥 Unexpected error in notifyCustomers():', err);
    process.exit(1);
  }
})();
