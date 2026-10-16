import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

const description =
  "New York practices that prescribe drugs needing prior auth, from public CMS data: routed to a queue and a territory, phone checked, measured for accuracy, and written as a HubSpot import.";

export const metadata: Metadata = {
  // absolute links for link previews: the card lives at codedvibesx.github.io/priormap
  metadataBase: new URL("https://codedvibesx.github.io/priormap/"),
  title: "priormap",
  description,
  openGraph: { title: "priormap", description, images: [{ url: "og.png", width: 2560, height: 1340, alt: "New York State, every practice that writes prior auth drugs lit up by queue" }], type: "website" },
  twitter: { card: "summary_large_image", title: "priormap", description, images: ["og.png"] },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
