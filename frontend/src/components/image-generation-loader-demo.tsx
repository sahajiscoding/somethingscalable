"use client";

import { ImageGenerationLoader } from "@/components/ui/image-generation-loader";

export default function ImageGenerationLoaderDemo() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:p-12">
      <div className="relative aspect-4/3 overflow-hidden rounded-2xl bg-neutral-900 outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        <img
          src="https://assets.aceternity.com/components/vertical-sliding-loader-demo.webp"
          alt="A project creation interface"
          className="size-full object-cover dark:hidden"
        />
        <img
          src="https://assets.aceternity.com/components/vertical-sliding-loader-demo-dark.webp"
          alt="A project creation interface"
          className="size-full object-cover not-dark:hidden"
        />
        <ImageGenerationLoader
          effect="scale-wave"
          easing="ease-in-out"
          text="Analysing"
          cellSize={3}
          gap={1}
          bandHeight={48}
          colors={["var(--color-blue-500)", "var(--color-blue-800)"]}
        />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <img
          src="https://assets.aceternity.com/avatars/manu.webp"
          alt="Manu Arora"
          className="size-9 rounded-full object-cover"
        />
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="shrink-0 text-base/7 font-medium sm:text-sm/6">
            Manu Arora
          </p>
          <p className="truncate text-base/7 text-neutral-500 sm:text-sm/6 dark:text-neutral-400">
            Multi cards empty state skeletons
          </p>
        </div>
      </div>
    </div>
  );
}
