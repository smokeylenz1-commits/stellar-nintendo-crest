import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get('name') || 'A trader';
  const earnings = searchParams.get('earnings') || '0';
  const code = searchParams.get('code') || '';

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0a0a0a',
          backgroundImage: 'radial-gradient(circle at 25% 25%, #1e3a8a 0%, transparent 50%), radial-gradient(circle at 75% 75%, #7c3aed 0%, transparent 50%)',
          fontFamily: 'sans-serif',
          padding: '60px',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '24px',
            padding: '60px 80px',
            width: '100%',
            height: '100%',
          }}
        >
          <div style={{ fontSize: 32, color: '#a1a1aa', marginBottom: 16, letterSpacing: 2 }}>
            iPredict Referral
          </div>
          <div style={{ fontSize: 72, fontWeight: 700, color: '#ffffff', marginBottom: 24, textAlign: 'center' }}>
            {name}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 40 }}>
            <div style={{ fontSize: 56, fontWeight: 700, color: '#22c55e' }}>
              ${earnings}
            </div>
            <div style={{ fontSize: 28, color: '#a1a1aa' }}>earned</div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: '#ffffff',
              color: '#0a0a0a',
              fontSize: 28,
              fontWeight: 600,
              padding: '16px 40px',
              borderRadius: '9999px',
            }}
          >
            Join &amp; earn 0.5% on every bet
          </div>
          {code ? (
            <div style={{ fontSize: 24, color: '#71717a', marginTop: 32 }}>
              Code: {code}
            </div>
          ) : null}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
