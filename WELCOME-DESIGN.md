# Eupova welcome-screen design

Mickel's feedback, 1 November 2026: the first redesign improved usability but needed a more premium visual identity. Future revisions to this screen should address typography, graphics, imagery, colour and appropriate motion as one system. Research relevant modern payment-product design, then implement and test locally. Keep the signed-in app and payment settings outside the visual edit unless explicitly requested.

For this revision Mickel chose a product showcase instead of testimonials. Do not present invented customers, ratings or quotes as social proof. Specific current art choices remain a design proposal awaiting his visual feedback, not a standing preference for every page.

Current proposal: original jade ribbon illustration, Space Grotesk display type, Manrope text, mint/green/lavender surfaces, a controlled three-scene product showcase and a closing account-entry banner. Both fonts are locally served under SIL OFL licences kept alongside the assets. Use the compressed WebP variants for the illustration. Generated source and final prompt are preserved in ../evidence/premium-home.

Retain explicit example labels, fee limitations and clear account actions. Motion must have visible controls, stop while the page is hidden or the scene is offscreen, pause on hover/focus and start still when reduced motion is requested. Keep manual scene navigation available. New local accounts survive visual changes and preview restarts; use the retained-schema startup script, never reset the test database as part of UI QA.

Evidence and change log: ../evidence/premium-home and ../action-log.md. Research recommendations are design hypotheses, not proof of conversion improvement. Test the actual rendered desktop/mobile page and ask Mickel to review it before deployment.
