"""
bill_processor.py — OCR-based electricity bill data extraction module.

Supports Indian electricity bills from:
  APSPDCL, APEPDCL, TSSPDCL, TSNPDCL, BESCOM, TANGEDCO, MSEDCL,
  BSES, TATA POWER, UPPCL, WBSEDCL, KSEB, and other standard formats.

Image preprocessing pipeline:
  1. Grayscale conversion
  2. Contrast enhancement (CLAHE)
  3. Noise removal (bilateral filter)
  4. Adaptive thresholding
  5. Rotation/deskew correction

Extracts: consumer number, billing month, total units consumed,
bill amount, meter readings, and electricity board.

Converts extracted data into structured format for ML processing.
"""

import re
import os
import io
import json
import random
import tempfile
import numpy as np
from datetime import datetime, timedelta
from PIL import Image, ImageEnhance, ImageFilter

# Optional OpenCV import — used for advanced preprocessing on tough bills
try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False
    print("[bill_processor] WARNING: OpenCV (cv2) not installed. "
          "Advanced preprocessing will be skipped.")

# ---------------------------------------------------------------------------
# Lazy-load OCR readers to avoid startup delay
# ---------------------------------------------------------------------------
_easyocr_reader = None

def _get_easyocr_reader():
    global _easyocr_reader
    if _easyocr_reader is None:
        import easyocr
        _easyocr_reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    return _easyocr_reader


# ---------------------------------------------------------------------------
# Image Preprocessing Pipeline
# ---------------------------------------------------------------------------

def preprocess_image(image_path):
    """Apply gentle preprocessing to improve OCR accuracy.

    Avoids hard binarization which destroys colored text on real bills.

    Returns:
        str: Path to the preprocessed temporary image file.
    """
    img = Image.open(image_path).convert('RGB')

    # 1. Resize small images for better OCR
    w, h = img.size
    if w < 1000 or h < 1000:
        scale = max(1200 / w, 1200 / h, 1.0)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    # 2. Grayscale
    gray = img.convert('L')

    # 3. Gentle contrast enhancement (not too aggressive)
    enhancer = ImageEnhance.Contrast(gray)
    gray = enhancer.enhance(1.5)

    # 4. Slight sharpening
    enhancer = ImageEnhance.Sharpness(gray)
    gray = enhancer.enhance(1.5)

    # NOTE: No binarization — hard thresholding destroys colored text
    # on real electricity bills (headers, highlighted amounts, etc.)

    # Save preprocessed image
    preprocessed_path = image_path + '_preprocessed.png'
    gray.save(preprocessed_path, 'PNG')
    return preprocessed_path


def preprocess_image_opencv(image_path):
    """Advanced preprocessing using OpenCV for tough/noisy bills.

    Pipeline:
      1. Read image with cv2
      2. Convert to grayscale
      3. CLAHE (Contrast Limited Adaptive Histogram Equalization)
      4. Bilateral filter for noise removal
      5. Adaptive Gaussian thresholding

    Returns:
      str | None: Path to the preprocessed temporary image, or None if
            OpenCV is unavailable.
    """
    if not _HAS_CV2:
        return None

    try:
        img = cv2.imread(image_path)
        if img is None:
            return None

        # 1. Grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # 2. CLAHE — adaptive contrast enhancement
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)

        # 3. Bilateral filter — edge-preserving noise removal
        gray = cv2.bilateralFilter(gray, 11, 75, 75)

        # 4. Adaptive Gaussian thresholding
        thresh = cv2.adaptiveThreshold(
            gray, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            blockSize=31,
            C=10,
        )

        # Save to a temp file
        fd, out_path = tempfile.mkstemp(suffix='_opencv.png')
        os.close(fd)
        cv2.imwrite(out_path, thresh)
        return out_path
    except Exception as exc:
        print(f"[bill_processor] OpenCV preprocessing failed: {exc}")
        return None


def preprocess_image_opencv_enhanced(image_path):
    """Advanced preprocessing using OpenCV without hard binarization.

    Keeps color gradients / gray levels which works much better for deep learning
    OCR models (CRAFT/CRNN) used in EasyOCR.

    Pipeline:
      1. Read image with cv2
      2. Convert to grayscale
      3. CLAHE (Contrast Limited Adaptive Histogram Equalization) with slightly higher contrast limit
      4. Bilateral filter for edge-preserving noise removal

    Returns:
      str | None: Path to the preprocessed temporary image, or None if
            OpenCV is unavailable.
    """
    if not _HAS_CV2:
        return None

    try:
        img = cv2.imread(image_path)
        if img is None:
            return None

        # 1. Grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # 2. CLAHE — adaptive contrast enhancement
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)

        # 3. Bilateral filter — noise removal
        gray = cv2.bilateralFilter(gray, 9, 75, 75)

        # Save to a temp file
        fd, out_path = tempfile.mkstemp(suffix='_opencv_enhanced.png')
        os.close(fd)
        cv2.imwrite(out_path, gray)
        return out_path
    except Exception as exc:
        print(f"[bill_processor] OpenCV enhanced preprocessing failed: {exc}")
        return None


def deskew_image(image_path):
    """Correct rotation/skew of a scanned bill using Hough line detection.

    Steps:
      1. Grayscale → Canny edge detection
      2. Probabilistic Hough transform to find line segments
      3. Compute median angle of detected lines
      4. Rotate image to correct if skew > 0.5°

    Returns:
        str: Path to the deskewed image (may be same as input if no
             correction was needed).
    """
    if not _HAS_CV2:
        return image_path

    try:
        img = cv2.imread(image_path)
        if img is None:
            return image_path

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)

        lines = cv2.HoughLinesP(
            edges, 1, np.pi / 180,
            threshold=100, minLineLength=100, maxLineGap=10,
        )

        if lines is None or len(lines) == 0:
            return image_path

        angles = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            # Only consider near-horizontal lines (within ±30°)
            if abs(angle) < 30:
                angles.append(angle)

        if not angles:
            return image_path

        median_angle = float(np.median(angles))

        if abs(median_angle) < 0.5:
            # Skew is negligible
            return image_path

        print(f"[bill_processor] Deskew: rotating by {median_angle:.2f}°")

        (h, w) = img.shape[:2]
        center = (w // 2, h // 2)
        rotation_matrix = cv2.getRotationMatrix2D(center, median_angle, 1.0)
        rotated = cv2.warpAffine(
            img, rotation_matrix, (w, h),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )

        fd, out_path = tempfile.mkstemp(suffix='_deskewed.png')
        os.close(fd)
        cv2.imwrite(out_path, rotated)
        return out_path
    except Exception as exc:
        print(f"[bill_processor] Deskew failed: {exc}")
        return image_path


# ---------------------------------------------------------------------------
# Text Extraction
# ---------------------------------------------------------------------------

def extract_text_from_image(image_path):
    """Extract text from image using EasyOCR with line-level detail.

    Uses detail mode (not paragraph mode) to preserve individual text
    lines and their spatial positions. This is critical for real bills
    where field labels and values must be associated by proximity.

    Pipeline:
      1. Optionally deskew the image (rotation correction)
      2. Run OCR on original, PIL-preprocessed, and OpenCV-preprocessed
      3. Return the result with the longest text
    """
    reader = _get_easyocr_reader()

    def _run_ocr(path):
        """Run OCR and return lines sorted top-to-bottom, left-to-right."""
        # detail=1 returns (bbox, text, confidence) tuples
        results = reader.readtext(path, detail=1, paragraph=False)
        if not results:
            return ''
        # Sort by vertical position (top of bounding box), then horizontal
        results.sort(key=lambda r: (r[0][0][1], r[0][0][0]))
        # Group into lines: items within 15px vertical distance = same line
        lines = []
        current_line = []
        current_y = None
        for bbox, text, conf in results:
            top_y = bbox[0][1]
            if current_y is None or abs(top_y - current_y) < 15:
                current_line.append(text)
                current_y = top_y if current_y is None else current_y
            else:
                lines.append(' '.join(current_line))
                current_line = [text]
                current_y = top_y
        if current_line:
            lines.append(' '.join(current_line))
        return '\n'.join(lines)

    # --- Step 0: Deskew the image before any OCR ---
    deskewed_path = deskew_image(image_path)
    deskew_is_temp = (deskewed_path != image_path)
    ocr_source = deskewed_path  # use deskewed version for all OCR runs

    temp_files = []  # track temp files for cleanup
    if deskew_is_temp:
        temp_files.append(deskewed_path)

    # --- Step 1: OCR on original (or deskewed) image ---
    try:
        text_original = _run_ocr(ocr_source)
    except Exception:
        text_original = ''

    # --- Step 2: OCR on PIL-preprocessed image ---
    preprocessed_path = None
    text_preprocessed = ''
    try:
        preprocessed_path = preprocess_image(ocr_source)
        temp_files.append(preprocessed_path)
        text_preprocessed = _run_ocr(preprocessed_path)
    except Exception:
        pass

    # --- Step 3: OCR on OpenCV-preprocessed image ---
    opencv_path = None
    text_opencv = ''
    try:
        opencv_path = preprocess_image_opencv(ocr_source)
        if opencv_path:
            temp_files.append(opencv_path)
            text_opencv = _run_ocr(opencv_path)
    except Exception:
        pass

    # --- Step 4: OCR on OpenCV-enhanced image (no binarization) ---
    opencv_enhanced_path = None
    text_opencv_enhanced = ''
    try:
        opencv_enhanced_path = preprocess_image_opencv_enhanced(ocr_source)
        if opencv_enhanced_path:
            temp_files.append(opencv_enhanced_path)
            text_opencv_enhanced = _run_ocr(opencv_enhanced_path)
    except Exception:
        pass

    # --- Cleanup temp files ---
    for tmp in temp_files:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    # --- Pick the best result (longest text) ---
    candidates = [
        ('original', text_original),
        ('PIL-preprocessed', text_preprocessed),
        ('OpenCV-preprocessed', text_opencv),
        ('OpenCV-enhanced', text_opencv_enhanced),
    ]
    best_label, best_text = max(candidates, key=lambda c: len(c[1]))
    print(f"[bill_processor] Best OCR source: {best_label} "
          f"({len(best_text)} chars vs "
          f"orig={len(text_original)}, "
          f"PIL={len(text_preprocessed)}, "
          f"OpenCV={len(text_opencv)}, "
          f"OpenCV-enhanced={len(text_opencv_enhanced)})")
    return best_text


def extract_text_from_pdf(pdf_path):
    """Extract text from a PDF file.

    First attempts direct text extraction via PyMuPDF.
    Falls back to OCR on rendered page images if text is sparse.
    """
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    all_text = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        if text and len(text.strip()) > 50:
            all_text.append(text)
        else:
            # Render page as high-DPI image and OCR
            pix = page.get_pixmap(dpi=300)
            img_data = pix.tobytes("png")
            temp_path = pdf_path + f'_page_{page_num}.png'
            with open(temp_path, 'wb') as f:
                f.write(img_data)
            ocr_text = extract_text_from_image(temp_path)
            all_text.append(ocr_text)
            try:
                os.remove(temp_path)
            except OSError:
                pass

    doc.close()
    return '\n'.join(all_text)


# ---------------------------------------------------------------------------
# Main Extraction Entry Point
# ---------------------------------------------------------------------------

def _extract_line_value(lines, label_pattern, value_pattern=r'([\d,\.]+)'):
    """Search lines for a label pattern and extract a nearby numeric value.

    This is the key improvement: instead of searching the entire merged text,
    we find the LINE containing the label and extract the value from that
    same line (or the next line if the value wraps).
    """
    for i, line in enumerate(lines):
        if re.search(label_pattern, line, re.IGNORECASE):
            # Try to find value on the same line, AFTER the label
            match = re.search(label_pattern + r'[^\d]*' + value_pattern, line, re.IGNORECASE)
            if match:
                return match.group(match.lastindex)
            # Try just finding any number on this line
            nums = re.findall(r'[\d,]+\.?\d*', line)
            # Pick the last number on the line (usually the value)
            if nums:
                return nums[-1]
            # Check next line for a standalone number
            if i + 1 < len(lines):
                nums = re.findall(r'[\d,]+\.?\d*', lines[i + 1])
                if nums:
                    return nums[0]
    return None


def extract_bill_data(file_path):
    """Extract structured bill data from an image or PDF.

    Uses line-by-line extraction: finds the line containing a field label,
    then extracts the value from that same line. This prevents grabbing
    unrelated numbers from other parts of the bill.

    Returns:
        dict: Extracted bill fields with confidence scores.

    Raises:
        ValueError: If file format is unsupported or OCR yields no text.
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp']:
        raw_text = extract_text_from_image(file_path)
    elif ext == '.pdf':
        raw_text = extract_text_from_pdf(file_path)
    else:
        raise ValueError(f"Unsupported file format: {ext}. Accepted: JPG, PNG, PDF")

    if not raw_text or len(raw_text.strip()) < 10:
        raise ValueError(
            "Could not extract readable text from the bill. "
            "The image may be blurry or too low resolution."
        )

    # ---- OCR Debug Logging ----
    print(f"[bill_processor] === OCR DEBUG ===")
    print(f"[bill_processor] Raw OCR text length: {len(raw_text)} chars")
    # Print first 500 chars of raw text for debugging
    raw_preview = raw_text[:500].encode('ascii', errors='replace').decode('ascii')
    print(f"[bill_processor] Raw OCR text (first 500 chars):")
    for line in raw_preview.split('\n'):
        print(f"  | {line}")
    print(f"[bill_processor] === END OCR DEBUG ===")

    # Split into lines for line-aware extraction
    lines = [l.strip() for l in raw_text.split('\n') if l.strip()]

    # Detect the electricity board
    board = detect_board(raw_text)

    # --- Line-aware extraction (primary) ---
    consumer_number = _extract_consumer_line(lines)
    billing_month = _extract_billing_month_line(lines)
    total_units = _extract_units_line(lines)
    bill_amount = _extract_amount_line(lines)
    previous_reading = _extract_reading_line(lines, 'previous')
    current_reading = _extract_reading_line(lines, 'current')

    # --- Fallback: old full-text regex (if line-aware missed) ---
    if not consumer_number:
        consumer_number = extract_consumer_number(raw_text)
    if not billing_month:
        billing_month = extract_billing_month(raw_text)
    if not total_units:
        total_units = extract_total_units(raw_text)
    if not bill_amount:
        bill_amount = extract_bill_amount(raw_text)
    if not previous_reading:
        previous_reading = extract_previous_reading(raw_text)
    if not current_reading:
        current_reading = extract_current_reading(raw_text)

    # If we have readings but no units, compute from readings
    if not total_units and previous_reading and current_reading:
        if current_reading > previous_reading:
            total_units = current_reading - previous_reading

    # ---- Debug: fields found / not found ----
    _field_status = {
        'consumer_number': consumer_number,
        'billing_month': billing_month,
        'total_units': total_units,
        'bill_amount': bill_amount,
        'previous_reading': previous_reading,
        'current_reading': current_reading,
    }
    found_names = [k for k, v in _field_status.items() if v]
    missing_names = [k for k, v in _field_status.items() if not v]
    print(f"[bill_processor] Fields FOUND ({len(found_names)}): {', '.join(found_names)}")
    print(f"[bill_processor] Fields MISSING ({len(missing_names)}): {', '.join(missing_names)}")

    # ---- Improved Confidence Scoring ----
    fields_found = sum([
        bool(total_units),
        bool(bill_amount),
        bool(consumer_number),
        bool(billing_month),
        bool(previous_reading or current_reading),
    ])

    # Base score: each of 5 fields contributes up to 16 points (max 80)
    confidence_score = fields_found * 16

    # Bonus: totalUnits is a reasonable number (1-10000)
    if total_units and 1 <= total_units <= 10000:
        confidence_score += 10
        print(f"[bill_processor] Confidence boost +10: totalUnits={total_units} is in reasonable range (1-10000)")
    elif total_units:
        print(f"[bill_processor] No confidence boost for totalUnits={total_units} (outside 1-10000)")

    # Bonus: billAmount matches reasonable Indian bill range (₹50-₹50000)
    if bill_amount and 50 <= bill_amount <= 50000:
        confidence_score += 10
        print(f"[bill_processor] Confidence boost +10: billAmount={bill_amount} is in reasonable Indian range (50-50000)")
    elif bill_amount:
        print(f"[bill_processor] No confidence boost for billAmount={bill_amount} (outside 50-50000)")

    # Ensure presence of critical 4 fields: Units, Amount, Month, Consumer Number
    has_critical_fields = bool(total_units) and bool(bill_amount) and bool(consumer_number) and bool(billing_month)
    if not has_critical_fields:
        # Cap confidence score at 65 (Medium) if any of the core 4 fields are missing
        confidence_score = min(65, confidence_score)
        print(f"[bill_processor] Capping confidence at {confidence_score}% because some critical fields are missing")

    # Clamp to 0-100
    confidence_score = max(0, min(100, confidence_score))

    # Text label from numeric score
    if confidence_score >= 70:
        confidence = 'high'
    elif confidence_score >= 40:
        confidence = 'medium'
    else:
        confidence = 'low'

    print(f"[bill_processor] Confidence: {confidence_score}% ({confidence})")
    print(f"[bill_processor] Extraction result: board={board}, "
          f"units={total_units}, amount={bill_amount}, "
          f"consumer={consumer_number}, month={billing_month}, "
          f"prev={previous_reading}, curr={current_reading}")

    result = {
        'consumer_number': consumer_number,
        'billing_month': billing_month,
        'total_units': total_units,
        'bill_amount': bill_amount,
        'previous_reading': previous_reading,
        'current_reading': current_reading,
        'electricity_board': board,
        'raw_text_length': len(raw_text),
        'fields_found': fields_found,
        'extraction_timestamp': datetime.now().isoformat(),
        'confidence': confidence,
        'confidence_score': confidence_score,
    }

    return result


# ---------------------------------------------------------------------------
# Line-Aware Extraction Functions (Primary — used before fallback regex)
# ---------------------------------------------------------------------------

def _extract_consumer_line(lines):
    """Find consumer/service number from the line containing the label."""
    label_pat = r'(?:consumer\s*(?:id|no|number|num|code)|service\s*(?:no|number|num|id|conn)|sc\s*(?:no|number|num|id)|rr\s*(?:no|number|num)|k\s*(?:no|number|num)|account\s*(?:no|number|num|id)|bp\s*no|ca\s*no|usc\s*no|consumer\s*number)'
    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            # Try splitting by common separators like colons, equals
            parts = re.split(r'[:=]', line, maxsplit=1)
            if len(parts) > 1:
                candidate = parts[1].strip()
                # Remove leading labels if they leaked in
                candidate = re.sub(r'^(?:no|number|num|id|#)\.?\s*', '', candidate, flags=re.IGNORECASE)
                # Find the first alphanumeric sequence (length 4 to 20) in the candidate
                match = re.search(r'([a-zA-Z0-9\-\/]{4,20})', candidate)
                if match:
                    return clean_consumer_number(match.group(1))
            
            # Fallback: Find alphanumeric sequences anywhere in the line after the label
            label_match = re.search(label_pat, line, re.IGNORECASE)
            after_label = line[label_match.end():]
            nums = re.findall(r'([a-zA-Z0-9\-\/]{4,20})', after_label)
            if nums:
                for n in nums:
                    cleaned = clean_consumer_number(n)
                    if cleaned and len(cleaned) >= 4 and not cleaned.lower() in ['no', 'number', 'num', 'code', 'id']:
                        return cleaned
    return None


def _extract_billing_month_line(lines):
    """Find billing month from the line containing BILL MONTH or similar."""
    label_pat = r'(?:bill\s*month|billing?\s*(?:month|period)|month\s*of|bill\s*date|date\s*of\s*bill|bill\s*dt)'
    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            # Check for Month Name + Year e.g. "March 2026" or "MAR-2026"
            m = re.search(r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-]*\d{4})', line, re.IGNORECASE)
            if m:
                return m.group(1).strip()
            # Check for standard dates e.g. "12/05/2026" or "12-05-2026"
            m = re.search(r'(\d{1,2}[\-/]\d{1,2}[\-/]\d{2,4})', line)
            if m:
                date_str = m.group(1).replace('I', '1').replace('l', '1').replace('O', '0').replace('o', '0')
                for fmt in ['%d/%m/%Y', '%d-%m-%Y', '%m/%d/%Y', '%m-%d-%Y', '%d/%m/%y', '%d-%m-%y']:
                    try:
                        dt = datetime.strptime(date_str, fmt)
                        return dt.strftime('%B %Y')
                    except ValueError:
                        continue
            # Check for MM/YYYY or MM-YYYY
            m = re.search(r'(\b\d{1,2}[\-/]\d{4}\b)', line)
            if m:
                month_str = m.group(1).replace('I', '1').replace('l', '1').replace('O', '0').replace('o', '0')
                parts = re.split(r'[\-/]', month_str)
                if len(parts) == 2:
                    try:
                        mon = int(parts[0])
                        yr = int(parts[1])
                        if 1 <= mon <= 12:
                            dt = datetime(yr, mon, 1)
                            return dt.strftime('%B %Y')
                    except ValueError:
                        pass
    return None


def _extract_units_line(lines):
    """Find total units consumed from lines containing unit-related labels."""
    # Priority 1: Table-based extraction — find header row with
    # "Current Reading" and "Units", then grab numbers from the next data row.
    for i, line in enumerate(lines):
        if re.search(r'current\s*reading', line, re.IGNORECASE) and \
           re.search(r'(?:units|consumed|kwh)', line, re.IGNORECASE):
            for j in range(i + 1, min(i + 6, len(lines))):
                data_line = lines[j]
                nums = re.findall(r'[\d,]+', data_line)
                if len(nums) >= 3:
                    vals = [clean_ocr_number(n) for n in nums]
                    vals = [v for v in vals if v is not None]
                    large_vals = sorted([v for v in vals if v > 1000], reverse=True)
                    if len(large_vals) < 2:
                        continue
                    diff = large_vals[0] - large_vals[1]
                    if 1 <= diff <= 50000:
                        return diff
                    small_vals = [v for v in vals if 1 <= v <= 5000 and v not in large_vals]
                    if small_vals:
                        from collections import Counter
                        counts = Counter(small_vals)
                        most_common = counts.most_common(1)[0]
                        if most_common[1] >= 2 and 1 <= most_common[0] <= 50000:
                            return most_common[0]

    # Priority 2: Label-based units
    label_pat = r'(?:consumed\s*units|units\s*consumed|total\s*units|billed\s*units|units\s*billed|consumption|energy\s*units|units\s*charged)'
    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            if re.search(r'reading', line, re.IGNORECASE):
                continue
            nums = re.findall(r'[\d,]+\.?\d*', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and 0 < val < 100000:
                    return val

    # Priority 3: "N units" or "N kwh" pattern (number BEFORE the word)
    for line in lines:
        m = re.search(r'(\d+)\s*(?:units|kwh)\b', line, re.IGNORECASE)
        if m:
            val = clean_ocr_number(m.group(1))
            if val and 10 < val < 100000:
                return val

    # Priority 4: Compute from readings
    curr = _extract_reading_line(lines, 'current')
    prev = _extract_reading_line(lines, 'previous')
    if curr and prev and curr > prev:
        diff = curr - prev
        if 1 <= diff <= 50000:
            return diff

    return None


def _extract_amount_line(lines):
    """Find bill amount from lines containing amount-related labels."""
    # Priority 1: "Total Amount Payable" or "Amount Payable"
    for line in lines:
        if re.search(r'total\s*amount\s*payable|amount\s*payable|net\s*payable', line, re.IGNORECASE):
            nums = re.findall(r'[\d,]+\.\d{2}', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and val > 0:
                    return val

    # Priority 2: "Total Amount" or "Net Amount" or "Grand Total"
    for line in lines:
        if re.search(r'total\s*amount|net\s*amount|grand\s*total|due\s*amount', line, re.IGNORECASE):
            nums = re.findall(r'[\d,]+\.?\d*', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and val > 10:
                    return val

    # Priority 3: "Bill Amount" or "Current Bill Amount"
    for line in lines:
        if re.search(r'(?:current\s*)?bill\s*amount|amount\s*due|total\s*charges', line, re.IGNORECASE):
            nums = re.findall(r'[\d,]+\.?\d*', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and val > 10:
                    return val
    return None


def _extract_reading_line(lines, reading_type='current'):
    """Find meter reading from lines containing reading labels.

    Handles two layouts:
    1. Inline: 'Current Reading: 12450' on one line
    2. Table: Header row has 'Current Reading | Previous Reading | ...'
       and the next line has the actual numbers '12450  12150  ...'
    """
    if reading_type == 'current':
        pattern = r'(?:present|current|curr\.?)\s*(?:reading|rdg|meter)'
    else:
        pattern = r'(?:previous|prev\.?|last|opening|initial)\s*(?:reading|rdg|meter)'

    for i, line in enumerate(lines):
        if re.search(pattern, line, re.IGNORECASE):
            # Check if this line also has numbers (inline format)
            nums = re.findall(r'[\d,]+', line)
            vals = [clean_ocr_number(n) for n in nums]
            vals = [v for v in vals if v is not None and v > 100]
            if vals:
                # If the header has BOTH current and previous reading labels,
                # this is a table header row — look at the next data line instead
                has_both = re.search(r'current\s*reading', line, re.IGNORECASE) and \
                           re.search(r'previous\s*reading', line, re.IGNORECASE)
                if has_both:
                    # Table header: parse data from next lines
                    for j in range(i + 1, min(i + 4, len(lines))):
                        data_nums = re.findall(r'[\d,]+', lines[j])
                        data_vals = [clean_ocr_number(n) for n in data_nums]
                        data_vals = [v for v in data_vals if v is not None and v > 100]
                        if len(data_vals) >= 2:
                            sorted_vals = sorted(data_vals, reverse=True)
                            if reading_type == 'current':
                                return sorted_vals[0]  # Larger = current
                            else:
                                return sorted_vals[1]  # Smaller = previous
                    continue
                return max(vals) if reading_type == 'current' else min(vals)

            # No numbers on this line — check the next line (table data row)
            if i + 1 < len(lines):
                next_nums = re.findall(r'[\d,]+', lines[i + 1])
                next_vals = [clean_ocr_number(n) for n in next_nums]
                next_vals = [v for v in next_vals if v is not None and v > 100]
                if next_vals:
                    return max(next_vals)
    return None


# ---------------------------------------------------------------------------
# Electricity Board Detection
# ---------------------------------------------------------------------------

def detect_board(text):
    """Detect the electricity board from bill text."""
    text_upper = text.upper()

    board_patterns = {
        'TSSPDCL': [r'TSSPDCL', r'TELANGANA\s*SOUTH', r'TS\s*SOUTH',
                     r'TELANGANA\s*STATE\s*SOUTH'],
        'TSNPDCL': [r'TSNPDCL', r'TELANGANA\s*NORTH', r'TS\s*NORTH'],
        'APSPDCL': [r'APSPDCL', r'SOUTHERN\s*POWER', r'AP\s*SOUTH',
                     r'ANDHRA\s*PRADESH\s*SOUTHERN'],
        'APEPDCL': [r'APEPDCL', r'EASTERN\s*POWER', r'AP\s*EAST',
                     r'ANDHRA\s*PRADESH\s*EASTERN'],
        'BESCOM':  [r'BESCOM', r'BANGALORE\s*ELECTRICITY',
                     r'BENGALURU\s*ELECTRICITY'],
        'MESCOM':  [r'MESCOM', r'MANGALORE\s*ELECTRICITY'],
        'HESCOM':  [r'HESCOM', r'HUBLI\s*ELECTRICITY'],
        'CESC':    [r'CESC', r'CHAMUNDESHWARI'],
        'TANGEDCO': [r'TANGEDCO', r'TNEB',
                      r'TAMIL\s*NADU\s*ELECTRICITY'],
        'MSEDCL':  [r'MSEDCL', r'MAHARASHTRA\s*STATE\s*ELECTRICITY',
                     r'MAHADISCOM'],
        'BSES':    [r'BSES', r'BSES\s*RAJDHANI', r'BSES\s*YAMUNA'],
        'TATA POWER': [r'TATA\s*POWER'],
        'UPPCL':   [r'UPPCL', r'UTTAR\s*PRADESH\s*POWER'],
        'WBSEDCL': [r'WBSEDCL', r'WEST\s*BENGAL\s*STATE'],
        'KSEB':    [r'KSEB', r'KERALA\s*STATE\s*ELECTRICITY'],
        'DHBVN':   [r'DHBVN', r'DAKSHIN\s*HARYANA'],
        'UHBVN':   [r'UHBVN', r'UTTAR\s*HARYANA'],
        'JVVNL':   [r'JVVNL', r'JAIPUR\s*VIDYUT'],
        'PSPCL':   [r'PSPCL', r'PUNJAB\s*STATE\s*POWER'],
    }

    for board_name, patterns in board_patterns.items():
        for pattern in patterns:
            if re.search(pattern, text_upper):
                return board_name

    return 'Unknown'


# ---------------------------------------------------------------------------
# Field Extraction Functions
# ---------------------------------------------------------------------------

def clean_ocr_number(num_str):
    if not num_str:
        return None
    # Replace common OCR confusions
    cleaned = num_str.replace('I', '1').replace('l', '1').replace('|', '1').replace('O', '0').replace('o', '0')
    cleaned = cleaned.replace(',', '')
    try:
        return float(cleaned)
    except ValueError:
        # Try to find a numeric/decimal block
        match = re.search(r'([0-9\.]+)', cleaned)
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                return None
    return None


def clean_consumer_number(num_str):
    if not num_str:
        return None
    # Clean up spaces and convert common OCR confused digits
    cleaned = num_str.replace('I', '1').replace('l', '1').replace('|', '1').replace('O', '0').replace('o', '0')
    return cleaned.strip()


def extract_consumer_number(text):
    """Extract consumer/service number from bill text."""
    patterns = [
        r'(?:consumer|consume|service|account|sc)\s*(?:no|number|#|id|num)[.:;\s]+'
        r'([a-zA-Z0-9\-/]{4,20})',
        r'(?:con\.?\s*no|cno|scno)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:RR\s*Number|RR\s*No)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:K\s*No|K\.No)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:contract\s*(?:no|number))[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:customer\s*(?:id|no|number))[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:supply\s*no)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return clean_consumer_number(match.group(1))
    return None


def extract_billing_month(text):
    """Extract billing month/period from bill text."""
    patterns = [
        r'(?:billing?\s*(?:month|period)|month\s*of|for\s*(?:the\s*)?month)'
        r'[.:;\s]*([A-Za-z]+[\s\-]*[0-9IOol]{2,4})',
        r'(?:bill\s*date|date\s*of\s*bill|bill\s*dt)[.:;\s]*'
        r'([0-9IOol]{1,2}[\-/][0-9IOol]{1,2}[\-/][0-9IOol]{2,4})',
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
        r'[a-z]*[\s\-,]*(?:20[0-9IOol]{2}))',
        r'([0-9IOol]{1,2}[\-/][0-9IOol]{4})',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = match.group(0).strip() if match.lastindex == 0 else match.group(1).strip()
            # Clean OCR digits in the month/year string
            val = val.replace('I', '1').replace('l', '1').replace('O', '0').replace('o', '0')
            return val
    return None


def extract_total_units(text):
    """Extract total units consumed from bill text."""
    patterns = [
        # Explicit "units consumed" labels
        r'(?:total\s*units?\s*(?:consumed|con\.?)|units?\s*consumed|'
        r'consumption\s*(?:units?)?)[.:;\s]*([0-9IOol\.\,]+)',
        # kWh labels
        r'(?:kwh\s*consumed|energy\s*consumed|energy\s*charges?\s*for)'
        r'[.:;\s]*([0-9IOol\.\,]+)',
        # Reading difference pattern
        r'(?:present|current|curr\.?)\s*(?:reading|rdg|pzading|feading|zading)[^0-9IOol]*([0-9IOol]+)\s*[\-]\s*'
        r'(?:previous|prev)\s*(?:reading|rdg|pzading|feading|zading)[^0-9IOol]*([0-9IOol]+)',
        # Telangana / AP specific patterns
        r'(?:consumption|units?\s*used)[.:;\s]*([0-9IOol\.\,]+)\s*(?:kwh|units?)?',
        r'(?:units?\s*charged|billable\s*units?)[.:;\s]*([0-9IOol\.\,]+)',
        # Generic "units" near a number
        r'([0-9IOol]+)\s*(?:units?\s*consumed|kwh\s*consumed|kwh)',
        r'(?:units|kwh)\s*[.:;\s]*([0-9IOol\.\,]+)',
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            groups = match.groups()
            if len(groups) == 2:
                val1 = clean_ocr_number(groups[0])
                val2 = clean_ocr_number(groups[1])
                if val1 is not None and val2 is not None:
                    diff = val1 - val2
                    if 0 < diff < 100000:
                        return diff
            else:
                val = clean_ocr_number(groups[0])
                if val is not None and 0 < val < 100000:
                    return val
    return None


def extract_bill_amount(text):
    """Extract total bill amount from bill text."""
    patterns = [
        r'(?:total\s*amount|net\s*amount|amount\s*payable|grand\s*total|'
        r'bill\s*amount)[.:;\s]*(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
        r'(?:Rs\.?\s*|₹\s*)([0-9IOol,\.]+)\s*(?:payable|due|total)',
        r'(?:current\s*bill\s*amount|this\s*month\s*amount)[.:;\s]*'
        r'(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
        r'(?:amount\s*due|amount\s*to\s*pay)[.:;\s]*'
        r'(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
        r'(?:payable\s*amount)[.:;\s]*(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = clean_ocr_number(match.group(1))
            if val is not None and val > 0:
                return val
    return None


def extract_previous_reading(text):
    """Extract previous meter reading."""
    patterns = [
        r'(?:previous|prev\.?|last)\s*(?:reading|rdg\.?|meter|pzading|feading|zading)[.:;\s]*'
        r'([0-9IOol\.\,]+)',
        r'(?:opening\s*reading|opening\s*pzading|opening\s*feading)[.:;\s]*([0-9IOol\.\,]+)',
        r'(?:initial\s*reading|initial\s*pzading|initial\s*feading)[.:;\s]*([0-9IOol\.\,]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = clean_ocr_number(match.group(1))
            if val is not None:
                return val
    return None


def extract_current_reading(text):
    """Extract current meter reading."""
    patterns = [
        r'(?:present|current|curr\.?)\s*(?:reading|rdg\.?|meter|pzading|feading|zading)[.:;\s]*'
        r'([0-9IOol\.\,]+)',
        r'(?:closing\s*reading|closing\s*pzading|closing\s*feading|final\s*reading|final\s*pzading|final\s*feading)[.:;\s]*([0-9IOol\.\,]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = clean_ocr_number(match.group(1))
            if val is not None:
                return val
    return None


# ---------------------------------------------------------------------------
# Bill Data → Energy Records Conversion
# ---------------------------------------------------------------------------

def bill_data_to_energy_records(bill_data, billing_date=None):
    """Convert extracted bill data into daily energy records for ML processing.

    Distributes monthly units across days with realistic daily variation
    that is unique per bill. Uses time-based seeding and consumption-proportional
    noise so different bills produce visibly different graphs.

    Args:
        bill_data: Dict from extract_bill_data()
        billing_date: Optional override for the billing end date.

    Returns:
        list: List of dicts with 'date' and 'units' keys (daily records).
    """
    total_units = bill_data.get('total_units')
    if not total_units or total_units <= 0:
        return []

    # Parse billing month to determine date range
    billing_month_str = bill_data.get('billing_month')
    if billing_date:
        end_date = billing_date
    elif billing_month_str:
        end_date = _parse_billing_month(billing_month_str)
    else:
        end_date = datetime.now()

    if end_date is None:
        end_date = datetime.now()

    # Assume 30-day billing cycle
    days_in_cycle = 30
    daily_avg = total_units / days_in_cycle

    records = []
    # Use current timestamp for seed so every upload produces unique patterns
    random.seed(int(datetime.now().timestamp() * 1000) % (2**31))

    # Generate a unique consumption profile with large enough variation
    # that different bills produce visibly different graphs
    noise_scale = daily_avg * 0.25  # ±25% variation

    for i in range(days_in_cycle):
        day_date = end_date - timedelta(days=days_in_cycle - 1 - i)

        # Weekday/weekend pattern
        weekday = day_date.weekday()
        if weekday >= 5:  # weekend
            day_factor = random.uniform(1.05, 1.25)
        elif weekday in [0, 4]:  # Monday/Friday
            day_factor = random.uniform(0.92, 1.08)
        else:  # mid-week
            day_factor = random.uniform(0.82, 1.02)

        # Add consumption-proportional noise
        noise = random.gauss(0, noise_scale * 0.4)
        day_units = round(daily_avg * day_factor + noise, 2)
        day_units = max(0.5, day_units)  # floor

        records.append({
            'date': day_date.strftime('%Y-%m-%dT00:00:00'),
            'units': day_units
        })

    # Normalize so total matches the bill's actual total
    generated_total = sum(r['units'] for r in records)
    if generated_total > 0:
        scale_factor = total_units / generated_total
        for r in records:
            r['units'] = round(r['units'] * scale_factor, 2)

    print(f"[bill_processor] Generated {len(records)} records, "
          f"total={sum(r['units'] for r in records):.1f} units "
          f"(bill total={total_units})")

    return records


def _parse_billing_month(month_str):
    """Try to parse a billing month string into a datetime."""
    formats = [
        '%B %Y', '%b %Y', '%B-%Y', '%b-%Y',
        '%m/%Y', '%m-%Y',
        '%d/%m/%Y', '%d-%m-%Y',
        '%Y-%m-%d', '%m/%d/%Y',
    ]
    cleaned = month_str.strip()

    for fmt in formats:
        try:
            return datetime.strptime(cleaned, fmt)
        except ValueError:
            continue

    # Try to extract month name + year
    match = re.search(
        r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
        r'[a-z]*[\s\-,]*(\d{4})',
        cleaned, re.IGNORECASE
    )
    if match:
        try:
            return datetime.strptime(
                f"{match.group(1)} {match.group(2)}", "%b %Y"
            )
        except ValueError:
            pass

    return None
