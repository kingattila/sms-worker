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
      return false;
    }
    console.log(`✅ Marked entry ${entry.id} as notified.`);
    return true;
  }
  return false;
}

async function notifyCustomers() {
  console.log('📋 Starting notifyCustomers at', new Date().toISOString());

  // Fetch all waiting queue entries (for context)
  const { data: allWaitingEntries, error: allQueueError } = await supabase
    .from('queue_entries')
    .select('id, customer_name, status, joined_at, requested_barber_id, shop_id, phone_number, notified')
    .eq('status', 'waiting')
    .order('joined_at', { ascending: true });

  if (allQueueError) {
    console.error('❌ Error fetching all queue entries:', allQueueError.message);
    return;
  }
  console.log(`📋 Found ${allWaitingEntries?.length || 0} total waiting queue entries:`, allWaitingEntries);

  // Fetch waiting queue entries (notified = false)
  const { data: entries, error: queueError } = await supabase
    .from('queue_entries')
    .select('id, customer_name, status, joined_at, requested_barber_id, shop_id, phone_number, notified')
    .eq('status', 'waiting')
    .eq('notified', false)
    .order('joined_at', { ascending: true });

  if (queueError) {
    console.error('❌ Error fetching queue (not notified):', queueError.message);
    return;
  }
  console.log(`📋 Found ${entries?.length || 0} waiting queue entries (not notified):`, entries);

  // Fetch waiting queue entries that are notified but not served
  const { data: notifiedEntries, error: notifiedError } = await supabase
    .from('queue_entries')
    .select('id, customer_name, status, joined_at, requested_barber_id, shop_id, phone_number, notified')
    .eq('status', 'waiting')
    .eq('notified', true)
    .order('joined_at', { ascending: true });

  if (notifiedError) {
    console.error('❌ Error fetching notified queue entries:', notifiedError.message);
    return;
  }
  console.log(`📋 Found ${notifiedEntries?.length || 0} waiting queue entries (notified):`, notifiedEntries);

  // Fetch active barbers
  const { data: barbers, error: barberError } = await supabase
    .from('barbers')
    .select('id, shop_id, status')
    .eq('status', 'active');

  if (barberError) {
    console.error('❌ Error fetching barbers:', barberError.message);
    return;
  }
  console.log(`📋 Found ${barbers?.length || 0} active barbers:`, barbers);

  // Fetch shops
  const { data: shops, error: shopError } = await supabase
    .from('barbershops')
    .select('id');

  if (shopError) {
    console.error('❌ Error fetching shops:', shopError.message);
    return;
  }
  console.log(`📋 Found ${shops?.length || 0} shops:`, shops);

  // Group barbers by shop
  const barbersByShop = {};
  barbers.forEach(barber => {
    if (!barbersByShop[barber.shop_id]) barbersByShop[barber.shop_id] = [];
    barbersByShop[barber.shop_id].push(barber.id);
  });
  console.log('📋 Barbers grouped by shop:', barbersByShop);

  // Group queue entries by shop (not notified)
  const queuesByShop = {};
  entries.forEach(entry => {
    const shopId = entry.shop_id;
    if (!queuesByShop[shopId]) queuesByShop[shopId] = [];
    queuesByShop[shopId].push(entry);
  });
  console.log('📋 Queue entries grouped by shop (not notified):', queuesByShop);

  // Group notified but waiting entries by shop
  const notifiedQueuesByShop = {};
  notifiedEntries.forEach(entry => {
    const shopId = entry.shop_id;
    if (!notifiedQueuesByShop[shopId]) notifiedQueuesByShop[shopId] = [];
    notifiedQueuesByShop[shopId].push(entry);
  });
  console.log('📋 Notified but waiting queue entries grouped by shop:', notifiedQueuesByShop);

  // Process each shop's queue
  for (const shopId in queuesByShop) {
    const queue = queuesByShop[shopId];
    const shop = shops.find(s => s.id === shopId);
    if (!shop) {
      console.error(`❌ Shop ${shopId} not found for queue entries.`);
      continue;
    }

    const activeBarberCount = barbersByShop[shopId]?.length || 0;
    const notifyPosition = activeBarberCount <= 2 ? 0 : activeBarberCount - 1;
    console.log(`📋 Processing shop ${shopId}: ${activeBarberCount} active barbers, notifyPosition=${notifyPosition + 1}`);

    // Check for notified but waiting "Any Barber" customers
    const notifiedWaiting = notifiedQueuesByShop[shopId]?.filter(e => e.requested_barber_id === null) || [];
    console.log(`📋 Found ${notifiedWaiting.length} notified but waiting "Any Barber" customers in shop ${shopId}:`, notifiedWaiting);

    // Group queue by specific barber and "Any Barber"
    const queuesByBarber = {};
    queue.forEach(entry => {
      const barberKey = entry.requested_barber_id || 'any';
      if (!queuesByBarber[barberKey]) queuesByBarber[barberKey] = [];
      queuesByBarber[barberKey].push(entry);
    });
    console.log(`📋 Queues for shop ${shopId} grouped by barber (not notified):`, queuesByBarber);

    // Process specific barber queues
    for (const barberKey in queuesByBarber) {
      const barberQueue = queuesByBarber[barberKey];
      if (barberKey === 'any') {
        // Skip if there are notified but waiting "Any Barber" customers for one barber
        if (activeBarberCount === 1 && notifiedWaiting.length > 0) {
          console.log(`📋 No notification for "Any Barber" in shop ${shopId}: ${notifiedWaiting.length} notified but waiting customers exist (single barber).`);
          continue;
        }
        // Notify customer at notifyPosition for "Any Barber"
        if (barberQueue.length > notifyPosition) {
          const entry = barberQueue[notifyPosition];
          if (!entry.notified) {
            console.log(`📢 Notifying ${entry.customer_name} (Any Barber) — position ${notifyPosition + 1} with ${activeBarberCount} active barbers.`);
            await notifyAndMark(entry, `You're #${notifyPosition + 1} in line at Fade Lab – get ready!`);
          } else {
            console.log(`📋 Skipping ${entry.customer_name} (Any Barber) — already notified at position ${notifyPosition + 1}.`);
          }
        } else {
          console.log(`📋 No notification for "Any Barber" in shop ${shopId}: queue length (${barberQueue.length}) <= notifyPosition (${notifyPosition + 1}).`);
        }
      } else {
        // Notify first customer for specific barber
        const entry = barberQueue[0];
        if (entry && !entry.notified) {
          console.log(`📢 Notifying ${entry.customer_name} for barber ${barberKey} — first in line.`);
          await notifyAndMark(entry, `You're next in line for your barber at Fade Lab!`);
        } else if (entry) {
          console.log(`📋 Skipping ${entry.customer_name} for barber ${barberKey} — already notified.`);
        } else {
          console.log(`📋 No customers in queue for barber ${barberKey} in shop ${shopId}.`);
        }
      }
    }
  }
}

(async () => {
  try {
    console.log('🚀 Starting cron job at', new Date().toISOString());
    await notifyCustomers();
    console.log('✅ Notification process completed.');
    process.exit(0);
  } catch (err) {
    console.error('💥 Unexpected error in notifyCustomers():', err);
    process.exit(1);
  }
})();