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
    if (error) {
      console.error(`❌ Could not mark entry ${entry.id} as notified:`, error.message);
    }
    return !error; // Return true if update was successful
  }
  return false;
}

async function notifyCustomers() {
  // Fetch waiting queue entries
  const { data: entries, error: queueError } = await supabase
    .from('queue_entries')
    .select('*')
    .eq('status', 'waiting')
    .eq('notified', false)
    .order('joined_at', { ascending: true });

  if (queueError || !entries) {
    console.error('❌ Error fetching queue:', queueError?.message);
    return;
  }

  // Fetch active barbers
  const { data: barbers, error: barberError } = await supabase
    .from('barbers')
    .select('id, shop_id')
    .eq('status', 'active');

  if (barberError || !barbers) {
    console.error('❌ Error fetching barbers:', barberError?.message);
    return;
  }

  // Fetch shop configurations
  const { data: shops, error: shopError } = await supabase
    .from('barbershops')
    .select('id, notify_threshold');

  if (shopError || !shops) {
    console.error('❌ Error fetching shops:', shopError?.message);
    return;
  }

  // Group barbers by shop
  const barbersByShop = {};
  barbers.forEach(barber => {
    if (!barbersByShop[barber.shop_id]) barbersByShop[barber.shop_id] = [];
    barbersByShop[barber.shop_id].push(barber.id);
  });

  // Group queue entries by shop
  const queuesByShop = {};
  entries.forEach(entry => {
    const shopId = entry.shop_id;
    if (!queuesByShop[shopId]) queuesByShop[shopId] = [];
    queuesByShop[shopId].push(entry);
  });

  // Process each shop's queue
  for (const shopId in queuesByShop) {
    const queue = queuesByShop[shopId];
    const shop = shops.find(s => s.id === shopId);
    if (!shop) {
      console.error(`❌ Shop ${shopId} not found.`);
      continue;
    }

    const activeBarberCount = barbersByShop[shopId]?.length || 0;
    // Use shop-specific threshold or default to activeBarberCount - 1
    const notifyThreshold = shop.notify_threshold !== null ? shop.notify_threshold : Math.max(activeBarberCount - 1, 0);

    // Group queue by specific barber and "Any Barber"
    const queuesByBarber = {};
    queue.forEach(entry => {
      const barberKey = entry.requested_barber_id || 'any';
      if (!queuesByBarber[barberKey]) queuesByBarber[barberKey] = [];
      queuesByBarber[barberKey].push(entry);
    });

    // Process specific barber queues
    for (const barberId in queuesByBarber) {
      const barberQueue = queuesByBarber[barberId];
      if (barberId === 'any') {
        // Notify customers for "Any Barber" at the correct position
        for (let i = 0; i < barberQueue.length; i++) {
          const entry = barberQueue[i];
          if (i === notifyThreshold && !entry.notified) {
            console.log(`📢 Notifying ${entry.customer_name} (Any Barber) — position ${i + 1} with ${activeBarberCount} active barbers.`);
            await notifyAndMark(entry, `You're almost up at Fade Lab – get ready!`);
          }
        }
      } else {
        // Notify first customer in line for a specific barber
        const entry = barberQueue[0];
        if (entry && !entry.notified) {
          console.log(`📢 Notifying ${entry.customer_name} for barber ${barberId}.`);
          await notifyAndMark(entry, `You're next in line for your barber at Fade Lab!`);
        }
      }
    }
  }
}

(async () => {
  try {
    await notifyCustomers();
    console.log('✅ Notification process completed.');
    process.exit(0);
  } catch (err) {
    console.error('💥 Unexpected error in notifyCustomers():', err);
    process.exit(1);
  }
})();