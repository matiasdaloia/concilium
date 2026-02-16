import type { APIRoute } from 'astro';

export const prerender = false;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const email = body?.email?.trim()?.toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
      return new Response(
        JSON.stringify({ success: false, error: 'invalid_email' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const supabaseUrl = import.meta.env.SUPABASE_URL;
    const supabaseKey = import.meta.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing Supabase environment variables');
      return new Response(
        JSON.stringify({ success: false, error: 'server_error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const res = await fetch(`${supabaseUrl}/rest/v1/waitlist`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ email, source: 'website' }),
    });

    if (res.ok) {
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (res.status === 409) {
      return new Response(
        JSON.stringify({ success: false, error: 'already_registered' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const errorBody = await res.text();
    console.error('Supabase error:', res.status, errorBody);

    return new Response(
      JSON.stringify({ success: false, error: 'server_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Waitlist API error:', err);
    return new Response(
      JSON.stringify({ success: false, error: 'server_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
