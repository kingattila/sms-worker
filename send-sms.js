require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

// Init Supabase and Twilio clients
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
    const result = await twilioClient.messages.create({
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
    const { error: updateError } = await supabase
      .from('queue_entries')
      .update({ notified: true })
      .eq('id', entry.id);

    if (updateError) {
      console.error(`❌ Failed to mark entry ${entry.id} as notified:`, updateError.message);
    } else {
      console.log(`✅ Marked entry ${entry.id} as notified.`);
    }
  }
}

async function notifyCustomers() {
  const { data: entries, error } = await supabase
    .from('queue_entries')
    .select('*')
    .eq('status', 'waiting')
    .eq('notified', false)
    .order('joined_at', { ascending: true });

  if (error) {
    console.error('❌ Error fetching queue:', error.message);
    return;
  }

  if (!entries || entries.length === 0) {
    console.log('✅ No entries to process.');
    return;
  }

  const { data: barbers, error: barbersError } = await supabase
    .from('barbers')
    .select('id, average_cut_time');

  if (barbersError) {
    console.error('❌ Error fetching barbers:', barbersError.message);
    return;
  }

  const barberMap = {};
  barbers.forEach((barber) => {
    barberMap[barber.id] = barber;
  });

  const { data: barbershops, error: shopsError } = await supabase
    .from('barbershops')
    .select('id, notify_threshold');

  if (shopsError) {
    console.error('❌ Error fetching barbershops:', shopsError.message);
    return;
  }

  const shopMap = {};
  barbershops.forEach((shop) => {
    shopMap[shop.id] = shop;
  });

  const shops = {};
  for (const entry of entries) {
    const shopId = entry.shop_id;
    if (!shops[shopId]) shops[shopId] = [];
    shops[shopId].push(entry);
  }

  for (const shopId in shops) {
    const queue = shops[shopId];
    const shop = shopMap[shopId];
    const notifyThreshold = shop?.notify_threshold || 10;

    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];

      if (entry.requested_barber_id) {
        const isNextForBarber = !queue.slice(0, i).some(
          (e) => e.requested_barber_id === entry.requested_barber_id
        );

        if (isNextForBarber) {
          console.log(`📢 Notifying "${entry.customer_name}" (${entry.phone_number}) — Reason: Next for their barber`);
          const msg = `You're next in line for your barber at Fade Lab!`;
          await notifyAndMark(entry, msg);
        } else {
          console.log(`⏳ Not notifying "${entry.customer_name}" — still waiting for their barber.`);
        }

      } else {
        // Handle 'Any barber' logic
        const unassignedAhead = queue.slice(0, i).filter(e => !e.requested_barber_id);
        const isFirstUnassigned = unassignedAhead.length === 0;

        let totalEstimatedWait = 0;
        for (let j = 0; j < i; j++) {
          const aheadEntry = queue[j];
          const barberId = aheadEntry.requested_barber_id;
          const cutTime = barberId && barberMap[barberId]
            ? barberMap[barberId].average_cut_time || 15
            : Object.values(barberMap)[0]?.average_cut_time || 15;
          totalEstimatedWait += cutTime;
        }

        const shouldNotify = isFirstUnassigned || totalEstimatedWait <= notifyThreshold;

        if (shouldNotify) {
          const reason = isFirstUnassigned
            ? 'First unassigned entry'
            : `Estimated wait time (${totalEstimatedWait} min) <= threshold (${notifyThreshold} min)`;

          console.log(`📢 Notifying "${entry.customer_name}" (${entry.phone_number}) — Reason: ${reason}`);
          const msg = `You're almost up at Fade Lab – get ready!`;
          await notifyAndMark(entry, msg);
        } else {
          console.log(`⏳ Not notifying "${entry.customer_name}" (${entry.phone_number}) — Estimated wait: ${totalEstimatedWait} min`);
        }
      }
    }
  }
}

// Run and handle exit codes for Render cron job
(async () => {
  try {
    await notifyCustomers();
    process.exit(0);
  } catch (err) {
    console.error('💥 Unexpected error in notifyCustomers():', err);
    process.exit(1);
  }
})();