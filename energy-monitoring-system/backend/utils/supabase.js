const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn('[Supabase] Warning: SUPABASE_URL or SUPABASE_KEY is missing from environment variables.');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder_key');

// Cache schema capability to prevent 500 errors on legacy databases
const tableHasUserId = {
    energy_data: false,
    predictions: false,
    anomalies: false,
    bill_records: true
};

async function detectSchema() {
    const tables = ['energy_data', 'predictions', 'anomalies'];
    for (const table of tables) {
        try {
            const { error } = await supabase
                .from(table)
                .select('user_id')
                .limit(1);
            if (error && error.code === '42703') {
                tableHasUserId[table] = false;
                console.log(`[Supabase Schema] Table "${table}" DOES NOT have user_id column. User-scoping for this table is disabled.`);
            } else {
                tableHasUserId[table] = true;
                console.log(`[Supabase Schema] Table "${table}" has user_id column. User-scoping for this table is enabled.`);
            }
        } catch (e) {
            tableHasUserId[table] = false;
        }
    }
}

// Run schema detection immediately
detectSchema();

module.exports = { supabase, tableHasUserId, detectSchema };
