"""Command line entry point:  ``python -m vision sheet.pdf``.

Use ``--no-model`` to inspect the crop layout without any API key, and
``--json out.json`` to dump crops, spans and confidences for the UI.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="vision",
        description="Crop handwritten answer blocks and transcribe them to LaTeX.",
    )
    parser.add_argument("path", help="student sheet (PDF, image or text)")
    parser.add_argument("--dpi", type=int, default=240)
    parser.add_argument("--max-blocks", type=int, default=32)
    parser.add_argument("--no-model", action="store_true",
                        help="layout only; no API calls")
    parser.add_argument("--providers", default="",
                        help="comma separated subset: nvidia,groq")
    parser.add_argument("--json", dest="json_path", default="",
                        help="write the full result as JSON")
    args = parser.parse_args(argv)

    from ingest import load_document, IngestError
    from vision import transcribe_document

    started = time.perf_counter()
    try:
        document = load_document(args.path, "student")
    except (IngestError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    load_ms = (time.perf_counter() - started) * 1000

    providers = []
    if not args.no_model:
        from vision.providers import build_providers

        available = build_providers()
        wanted = {
            name.strip().lower()
            for name in args.providers.split(",")
            if name.strip()
        }
        providers = [
            provider for provider in available
            if not wanted or provider.name in wanted
        ]
        missing = wanted - {provider.name for provider in providers}
        if missing:
            print(
                "warning: unavailable provider(s): " + ", ".join(sorted(missing)),
                file=sys.stderr,
            )
        if not providers:
            print(
                "warning: no vision provider configured; running layout only",
                file=sys.stderr,
            )

    started = time.perf_counter()
    pages = transcribe_document(
        document,
        providers=providers,
        dpi=args.dpi,
        max_blocks=args.max_blocks,
    )
    run_ms = (time.perf_counter() - started) * 1000

    crops = sum(len(page.crops) for page in pages)
    print(f"file: {Path(args.path).name}")
    print(f"kind: {document.kind}   pages: {len(pages)}   crops: {crops}")
    print(f"load: {load_ms:.0f} ms   pipeline: {run_ms:.0f} ms")

    for page in pages:
        print(f"\npage {page.page}   {page.width}x{page.height}   "
              f"fidelity={page.fidelity}")
        for crop in page.crops:
            transcription = page.transcriptions.get(crop.crop_id)
            latex = transcription.latex if transcription else ""
            confidence = transcription.confidence if transcription else 0.0
            note = transcription.note if transcription else ""
            suffix = f"   [{note}]" if note else ""
            print(f"  {crop.crop_id}  conf={confidence:.2f}  "
                  f"{latex[:100]}{suffix}")
        for warning in page.warnings:
            print(f"  ! {warning}")

    if args.json_path:
        payload = {
            "file": Path(args.path).name,
            "kind": document.kind,
            "pages": [page.to_dict() for page in pages],
        }
        Path(args.json_path).write_text(
            json.dumps(payload, indent=2), encoding="utf-8"
        )
        print(f"\njson: {args.json_path}")

    if not pages:
        return 2
    if providers and all(page.fidelity == "unreadable" for page in pages):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
