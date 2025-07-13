console.log("🧪 Loaded ENV:", {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER
});
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function notifyCustomers() {
  try {
    console.log("🔍 Fetching queue entries...");

    const { data: queueEntries, error } = await supabase
      .from("queue_entries")
      .select("*")
      .eq("notified", false)
      .order("joined_at", { ascending: true });

    if (error) {
      console.error("❌ Supabase query error:", error.message);
      return;
    }

    if (!queueEntries.length) {
      console.log("✅ No customers to notify.");
      return;
    }

    for (const entry of queueEntries) {
      const customerName = entry.name || "there";
      console.log(`📤 Sending SMS to ${customerName} (${entry.phone_number})...`);

      const message = await twilioClient.messages.create({
        body: `Hi ${customerName}, you're up next at the barbershop! Please make your way over.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: entry.phone_number,
      });

      console.log(`✅ SMS sent to ${entry.phone_number}. SID: ${message.sid}`);

      await supabase
        .from("queue_entries")
        .update({ notified: true })
        .eq("id", entry.id);
    }

    console.log("🎉 All customers notified.");
  } catch (err) {
    console.error("🔥 Unhandled error:", err.message);
  }
}

notifyCustomers();