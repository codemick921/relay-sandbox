# Eupova design philosophy and reusable style

Approved direction: Mickel reviewed the premium welcome screen on 1 November 2026, requested Render publication, and asked to carry its style into other pages. This guide records the choices made; it does not authorise redesigning every page at once.

## Philosophy

Make the path from money to wallet easy to understand. Premium comes from clear hierarchy, deliberate spacing, consistent materials and calm movement. Show what the product does before asking visitors to create an account. Use one recognisable visual language across public and signed-in pages, while giving payment decisions more space and less decoration.

The ribbon moving through portals is a metaphor for a funding route, not evidence of an actual transfer. Product examples explain Wallet → Review → Follow. State what is known, what is estimated and what still needs checking. A polished screen must not make an incomplete payment look successful.

## Typography

- Space Grotesk (local EupovaDisplay), weight 500: headings and concise display statements. Its geometric forms give the brand character.
- Manrope (local EupovaBody), usually 400–650: text, labels and controls. Keep numbers, currency, addresses and status text readable.
- Both fonts are self-hosted Latin WOFF2 under SIL OFL; licences live in src/assets/fonts. Use system fallbacks for unsupported scripts.
- Desktop hero: 46–64px, line-height 1.04. Section headings: roughly 34–46px. Body: 15–16px with generous line height. The smaller welcome captions are not the standard for important transactional information.
- Use short headings, sentence case and plain actions. Do not apply the hero’s tight tracking to dense forms or payment amounts.

## Colour roles

| Role | Current colour | Use |
|---|---|---|
| Main ink | #183d30 | Headings and strong text |
| Deep jade | #204f3b | Primary actions, closing banner |
| Muted green | #53665b | Supporting text on light surfaces |
| Mint | #edf4ef | Calm hero and large supporting surfaces |
| White | #ffffff | Forms and readable content panels |
| Lavender | #e4def0 | Product demonstration and secondary emphasis |
| Pale lime | #e8edb3 | Small graphic accents; action on dark jade |
| Focus violet | #7655ad | Visible keyboard focus ring |

Colour has a purpose. Avoid gradients everywhere, rainbow panels or generic blue finance styling. Lavender is demonstration emphasis, not a payment-state colour. Success, pending, error and disabled states must have text/icon cues and be chosen for the actual state; never reuse green as unsupported proof of settlement. Recheck contrast on each new combination.

## Layout and components

Use a centred content shell up to 1280px. Desktop side space is about 56px; mobile 20px (16px on the narrowest screen). Use responsive grids that collapse naturally. Hero artwork and concise copy balance each other. Signed-in pages should use the same fonts, colours and rounded controls but shorter headings, compact navigation and content-first layouts.

Controls use roughly 8px corners; small floating panels 12px; large demonstration surfaces 20–24px. Subtle borders and restrained shadows separate layers. Keep touch targets at least 44px, visible focus, sensible tab order and labels that explain the action. Prefer one primary action per decision area, secondary text actions and progressive disclosure for detail.

Reusable patterns: branded header; clear page title and short explanation; primary action; white content panels; labelled progress; native expandable questions; explicit recovery action. Keep invitations, currency choice, saved records and existing navigation functional during migration.

## Mobile header clearance

The earlier padding-only mobile Sign in adjustment did not resolve Mickel’s iPhone 15 Chrome complaint. On screens up to 760px, keep a full-width, high-contrast 52px Sign in button in its own header row below the logo, with safe-area-aware top clearance. Provide a second in-flow Sign in action beside Create account. Preserve the desktop layout. Check narrow and reduced-height viewports, both sign-in actions and no horizontal overflow. Physical iPhone Chrome confirmation remains required: emulation alone does not prove native toolbar visibility.

## Imagery and movement

Original jade/ivory 3D ribbon artwork is the public-page signature. Compressed responsive WebPs are in src/assets. Decorative artwork has empty alt text; route labels are real readable HTML. Avoid stock crypto coins, fabricated balances, unapproved partner badges and fake customer proof.

Use the product showcase until genuine approved testimonials exist. Current scene rotation is eight seconds only while visible; pause on hover/focus or hidden/offscreen, provide Play/Pause and manual steps, retain pause choice for the session and start still for reduced motion. Scene transitions are 250ms and disabled for reduced motion. Do not bring autoplay into payment review, recovery warnings or tasks that need concentration. No GIF is required when a lighter controllable animation communicates the same idea.

## Page-by-page adoption

1. Read the current screen and preserve its functional contract.
2. Identify the customer’s next action and organise around it.
3. Reuse fonts, colour roles, control shape, spacing and icon treatment; vary layout with the task.
4. Keep sample, pending, paid and received states distinct. Removing the public testing banner does not change payment capabilities or hide simulation labels inside test flows.
5. Check desktop, tablet, 390px and 320px widths; keyboard operation; reduced motion; real contrast; image/font loading; console errors and navigation. Do not create live payments to validate visual changes.
6. Show Mickel the next page for review before broadening the redesign.

## Provenance and limits

Implemented source: src/Welcome.jsx and src/welcome.css. Research and original artwork evidence: ../evidence/premium-home in the connected-funding workspace. Visual direction draws on first-party Wise brand/type case studies, Mercury’s product presentation and W3C carousel guidance; exact implementations are original to Eupova. Opus 5.5 High provided the recorded art-direction synthesis, then local implementation adapted it to verified product capabilities. No measured conversion lift or user-study result is claimed.

## Sign-in application — 1 November 2026

Implemented for local review, not yet approved for publication. Mickel requested a brighter and more sophisticated sign-in using the previous pages’ design elements. The desktop layout pairs an original ribbon illustration on mint with a white form. Lavender and pale-lime background washes add colour without reducing form contrast. Space Grotesk supplies heading character; Manrope remains the form typeface. Artwork edges fade into the mint surface rather than creating a hard image strip.

At 900px and below, remove the large side panel and keep a small decorative ribbon beside the logo. Give the form normal document scrolling, safe-area-aware outer space, 16px inputs, 44px minimum action targets and violet keyboard focus. The form remains the first task; no carousel, GIF, fabricated balances or decorative success states. Keep recovery, email verification and account security in a quieter single-panel layout with prominent notices.

Use AccessPassword for the reviewed show/hide control: explicit labels, password-manager autocomplete, no form submission from the toggle, hidden on mode change, and cursor restoration cancelled if typing resumes. Do not broaden this visual change into credential-policy or recovery-flow changes. Retain invitation codes, recovery acknowledgement, tester separation, saved requests and payment settings.

Verified locally in isolated Chromium at 1440×900, 768×1024, 393×852, 393×660, 320×568 and 852×393; enlarged desktop layout and keyboard paths were also checked. Physical iPhone browser toolbar and WebKit behaviour remain unverified. This design is a hypothesis for clarity and engagement; no conversion uplift has been measured.
