# Polaris Brand Assets

## Circle login-code email (user-controlled wallet)

Paste the HTML below into **Circle Console → Programmable Wallets → User-Controlled → Email template**.

It is table-based with inline CSS so it renders consistently in Gmail, Outlook,
and Apple Mail, and it keeps Circle's merge variables `{{code}}` and
`{{expiry_long}}` (do not rename them).

Email clients do not render SVG, so the Polaris mark uses the four-point star
glyph (`&#10022;`). To use an image instead, host a PNG and swap the star
`<span>` for:

```html
<img src="https://polarisswarm.vercel.app/polaris-mark.png" width="26" height="26" alt="Polaris" style="display:block;border:0;" />
```

### Copy this:

```html
<div style="margin:0;padding:0;background:#F6F7F9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F9;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#FFFFFF;border:1px solid #E2E6EC;border-radius:16px;overflow:hidden;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

          <!-- Header -->
          <tr>
            <td style="background:#0B1020;padding:26px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <span style="display:inline-block;font-size:26px;line-height:26px;color:#5B9BFF;">&#10022;</span>
                  </td>
                  <td style="vertical-align:middle;padding-left:10px;">
                    <span style="font-size:20px;font-weight:700;letter-spacing:1px;color:#FFFFFF;">POLARIS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 8px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#101622;">Log in to Polaris</h1>
              <p style="margin:0 0 24px;font-size:15px;line-height:22px;color:#56647A;">
                Use the verification code below to finish signing in to your Polaris wallet.
              </p>

              <!-- Code -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background:#F6F7F9;border:1px solid #E2E6EC;border-radius:12px;padding:22px;">
                    <div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#2D7EF8;">{{code}}</div>
                  </td>
                </tr>
              </table>

              <p style="margin:20px 0 0;font-size:13px;line-height:20px;color:#8E9AAC;">
                This code expires in {{expiry_long}}. Enter it in Polaris to complete verification.
                If you did not request this, you can safely ignore this email. No action is needed.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:24px 32px 0;">
              <div style="border-top:1px solid #E2E6EC;line-height:1px;font-size:1px;">&nbsp;</div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 32px;">
              <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#101622;">The Polaris Team</p>
              <p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#56647A;">
                The AI Agent Payment Rail. Settled in USDC on Arc.
              </p>
              <p style="margin:0;font-size:12px;line-height:18px;color:#8E9AAC;">
                <a href="https://polarisswarm.vercel.app" style="color:#2D7EF8;text-decoration:none;">polarisswarm.vercel.app</a>
                &nbsp;&middot;&nbsp;
                <a href="https://polarisswarm.vercel.app/docs" style="color:#2D7EF8;text-decoration:none;">Docs</a>
              </p>
              <p style="margin:12px 0 0;font-size:11px;line-height:16px;color:#B6BECC;">
                &copy; 2026 Polaris. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</div>
```

## Brand palette

| Token | Hex | Use |
| --- | --- | --- |
| Star light | `#5B9BFF` | logo highlight |
| Blue | `#2D7EF8` | primary / links / code |
| Violet | `#7C3AED` | gradient accent |
| Navy | `#0B1020` | dark header band |
| Ink | `#101622` | primary text |
| Muted | `#56647A` | secondary text |
| Faint | `#8E9AAC` | tertiary text |
| Border | `#E2E6EC` | dividers / borders |
| Surface | `#F6F7F9` | page / input background |

- **Mark:** four-point north star, blue→violet gradient (`#5B9BFF → #2D7EF8 → #7C3AED`). Source: [`public/polaris-mark.svg`](./public/polaris-mark.svg).
- **Fonts:** Outfit (sans), Fraunces (display), JetBrains Mono (mono).
- **Tagline:** The AI Agent Payment Rail.
