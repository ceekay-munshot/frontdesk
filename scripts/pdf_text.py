#!/usr/bin/env python3
"""pdf_text.py — print the plain text of a PDF (used by the ratings auto-feeder).

The credit-rating auto-feeder downloads a rating agency's report PDF from the
stock-exchange filing and needs its text so the LLM can read the new rating out
of it. PDF text extraction is one thing Python (pymupdf) does far more reliably
than anything available in the Node runtime, so the Node feeder shells out here.

Usage:  python3 pdf_text.py <file.pdf> [max_chars]
Prints the extracted text (optionally truncated) to stdout. Never raises: on any
failure it prints nothing and exits 0, so the feeder treats it as "no text" and
falls back to the announcement headline rather than crashing the refresh.
"""
import sys

def main() -> None:
    if len(sys.argv) < 2:
        return
    path = sys.argv[1]
    max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    try:
        import pymupdf  # PyMuPDF
        parts = []
        with pymupdf.open(path) as doc:
            for page in doc:
                parts.append(page.get_text())
        text = "\n".join(parts)
    except Exception:
        return
    # Collapse runs of spaces/tabs; keep newlines (they separate table rows).
    text = "\n".join(" ".join(line.split()) for line in text.splitlines())
    if max_chars and len(text) > max_chars:
        text = text[:max_chars]
    sys.stdout.write(text)

if __name__ == "__main__":
    main()
