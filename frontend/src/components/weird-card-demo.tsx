"use client";

import { useState } from "react";
import { CardBody, CardContainer, CardItem } from "@/components/ui/3d-card";

export default function WeirdCardDemo() {
  const [pokes, setPokes] = useState(0);
  const poke = () => setPokes(n => n + 1);

  return (
    <CardContainer className="inter-var">
      <CardBody className="relative group/card w-auto sm:w-[30rem] h-auto rounded-xl p-6 border border-fuchsia-500/30 bg-black shadow-[0_0_70px_rgba(217,70,239,.18)]">
        <CardItem
          translateZ="50"
          className="text-xl font-black tracking-tight text-lime-300"
        >
          👁️ THE ALL-SEEING GRADER
        </CardItem>
        <CardItem
          as="p"
          translateZ="60"
          className="text-neutral-400 text-sm max-w-sm mt-2"
        >
          It sees every skipped step. Hover to make it nervous.
        </CardItem>
        <CardItem translateZ="100" className="w-full mt-4">
          <div className="grid h-60 w-full place-items-center overflow-hidden rounded-xl border-2 border-dashed border-fuchsia-500/60 bg-[repeating-linear-gradient(45deg,#0a0a0a_0_18px,#14041a_18px_36px)] group-hover/card:shadow-[0_0_40px_rgba(217,70,239,.35)]">
            <div className="text-center">
              <div className="animate-bounce text-6xl" aria-hidden="true">
                🛸
              </div>
              <div className="mt-2 font-mono text-lg font-bold tracking-[.25em] text-fuchsia-300">
                ⚠ PLACEHOLDER
              </div>
              <div className="mt-1 font-mono text-xs text-neutral-500">
                weird-thing.png — failed to load (on purpose)
              </div>
            </div>
          </div>
        </CardItem>
        <div className="flex justify-between items-center mt-6">
          <CardItem
            translateZ={20}
            as="button"
            onClick={poke}
            className="cursor-pointer px-4 py-2 rounded-xl text-xs font-normal text-neutral-300 border border-white/10"
          >
            Poke it →
          </CardItem>
          <CardItem
            translateZ={20}
            as="button"
            onClick={poke}
            className="cursor-pointer px-4 py-2 rounded-xl bg-red-600 text-white text-xs font-bold"
          >
            DO NOT PRESS
          </CardItem>
        </div>
        {pokes > 0 && (
          <div className="mt-3 text-center font-mono text-xs text-red-400" role="status">
            ⚠ the grader saw that ×{pokes} — no marks deducted (this time)
          </div>
        )}
      </CardBody>
    </CardContainer>
  );
}
