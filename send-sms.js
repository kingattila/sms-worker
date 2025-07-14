// ✅ send-sms.js — Updated with full notification logic
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const now = new Date();
const localNow = new Date(
  now.toLocaleString('en-US', { timeZone: 'Australia/Adelaide' })
);
const hours = localNow.getHours();
if (hours < 8 || hours >= 20) {
  console.log('Outside working hours, skipping execution.');
  process.exit(0);
}

async function run() {
  const { data: barbershops, error: shopErr } = await supabase
    .from('barbershops')
    .select('id, notify_threshold');

  if (shopErr) {
    console.error('Error loading shops:', shopErr);
    return;
  }

  for (const shop of barbershops) {
    const { data: barbers, error: barberErr } = await supabase
      .from('barbers')
      .select('id, average_cut_time')
      .eq('shop_id', shop.id)
      .eq('status', 'active');

    if (barberErr) continue;

    for (const barber of barbers) {
      const { data: queue, error: queueErr } = await supabase
        .from('queue_entries')
        .select('*')
        .eq('shop_id', shop.id)
        .eq('status', 'waiting')
        .order('joined_at', { ascending: true });

      if (queueErr) continue;

      const filteredQueue = queue.filter(e =>
        e.requested_barber_id === barber.id || e.requested_barber_id === null
      );

      let position = 0;
      for (const entry of filteredQueue) {
        const isSpecific = entry.requested_barber_id === barber.id;
        const estimatedWait = position * (barber.average_cut_time || 15);

        if (
          !entry.notified &&
          (
            (isSpecific && position === 0) ||
            (!isSpecific && (position === 0 || estimatedWait <= shop.notify_threshold))
          )
        ) {
          try {
            const message = await client.messages.create({
              body: `Hi ${entry.customer_name}, you're almost up at the barber!`,
              from: process.env.TWILIO_PHONE_NUMBER,
              to: entry.phone_number,
            });

            await supabase
              .from('queue_entries')
              .update({ notified: true })
              .eq('id', entry.id);

            console.log(`✅ SMS sent to ${entry.customer_name}: ${message.sid}`);
          } catch (err) {
            console.error(`❌ Failed to send SMS to ${entry.customer_name}:`, err);
          }
        }
        position++;
      }
    }
  }
}

run();