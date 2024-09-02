"use client";
import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    window.location.href = "https://dial.to/developer?url=https%3A%2F%2Fclaimsquadsrent.simplysabir.xyz%2Fapi%2Faction%2Fclaim-rent%3Faction%3Dclaim&cluster=mainnet";
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1>Redirecting...</h1>
    </main>
  );
}
