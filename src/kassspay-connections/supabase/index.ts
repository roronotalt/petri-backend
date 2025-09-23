import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_PROJECT_URL) throw new Error('SUPABASE_PROJECT_URL is not set');
if (!process.env.SUPABASE_API_KEY) throw new Error('SUPABASE_API_KEY is not set');

export const supabase = createClient(
	process.env.SUPABASE_PROJECT_URL,
	process.env.SUPABASE_API_KEY
);
