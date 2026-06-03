"""
ocr_validator.py — Validation rules engine for OCR-extracted electricity bill fields.

Validates extracted data against configurable rules and returns structured
validation results with severity levels and human-readable messages.
"""

import re
from datetime import datetime, timedelta


# ---------------------------------------------------------------------------
# Rule Classes
# ---------------------------------------------------------------------------

class ValidationResult:
    """Result of a single validation check."""
    __slots__ = ('valid', 'message', 'severity')

    def __init__(self, valid, message=None, severity='info'):
        self.valid = valid
        self.message = message  # Human-readable message
        self.severity = severity  # 'error', 'warning', 'info'

    def to_dict(self):
        return {
            'valid': self.valid,
            'message': self.message,
            'severity': self.severity,
        }


class NumericRule:
    """Check that a value is numeric and within an optional range."""
    def __init__(self, min_val=None, max_val=None):
        self.min_val = min_val
        self.max_val = max_val

    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)  # Missing values handled separately
        try:
            num = float(value)
        except (TypeError, ValueError):
            return ValidationResult(False, f'Value "{value}" is not numeric', 'error')
        if self.min_val is not None and num < self.min_val:
            return ValidationResult(False, f'Value {num} is below minimum ({self.min_val})', 'error')
        if self.max_val is not None and num > self.max_val:
            return ValidationResult(False, f'Value {num} exceeds maximum ({self.max_val})', 'error')
        return ValidationResult(True)


class PositiveRule:
    """Check that a numeric value is positive."""
    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)
        try:
            num = float(value)
        except (TypeError, ValueError):
            return ValidationResult(True)  # Non-numeric handled by NumericRule
        if num <= 0:
            return ValidationResult(False, f'Value {num} must be positive', 'error')
        return ValidationResult(True)


class ReasonableRangeRule:
    """Warn if a value is outside a typical range (not an error, just suspicious)."""
    def __init__(self, typical_min=None, typical_max=None, warning=None):
        self.typical_min = typical_min
        self.typical_max = typical_max
        self.warning = warning or 'Value is outside typical range'

    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)
        try:
            num = float(value)
        except (TypeError, ValueError):
            return ValidationResult(True)
        if self.typical_min is not None and num < self.typical_min:
            return ValidationResult(
                False,
                f'{self.warning}: {num} is below typical minimum ({self.typical_min})',
                'warning',
            )
        if self.typical_max is not None and num > self.typical_max:
            return ValidationResult(
                False,
                f'{self.warning}: {num} exceeds typical maximum ({self.typical_max})',
                'warning',
            )
        return ValidationResult(True)


class DateFormatRule:
    """Check that a string matches one of several date formats."""
    def __init__(self, formats=None):
        self.formats = formats or ['%d/%m/%Y', '%d-%m-%Y', '%B %Y', '%b %Y']

    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)
        value_str = str(value).strip()
        if not value_str:
            return ValidationResult(True)
        for fmt in self.formats:
            try:
                datetime.strptime(value_str, fmt)
                return ValidationResult(True)
            except ValueError:
                continue
        # Also accept "Month YYYY" patterns via regex
        if re.match(r'^[A-Za-z]+\s+\d{4}$', value_str):
            return ValidationResult(True)
        return ValidationResult(
            False,
            f'Date "{value_str}" does not match expected formats',
            'warning',
        )


class DateRangeRule:
    """Warn if a date is too far in the past or future."""
    def __init__(self, max_years_ago=2, max_years_future=1):
        self.max_years_ago = max_years_ago
        self.max_years_future = max_years_future

    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)
        dt = _parse_date_flexible(str(value))
        if dt is None:
            return ValidationResult(True)  # Can't parse, skip range check
        now = datetime.now()
        if dt < now - timedelta(days=self.max_years_ago * 365):
            return ValidationResult(
                False,
                f'Date appears to be more than {self.max_years_ago} years ago',
                'warning',
            )
        if dt > now + timedelta(days=self.max_years_future * 365):
            return ValidationResult(
                False,
                f'Date appears to be more than {self.max_years_future} year(s) in the future',
                'warning',
            )
        return ValidationResult(True)


class MinLengthRule:
    """Check that a string has minimum length."""
    def __init__(self, min_length):
        self.min_length = min_length

    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)
        if len(str(value)) < self.min_length:
            return ValidationResult(
                False,
                f'Value is too short (minimum {self.min_length} characters)',
                'warning',
            )
        return ValidationResult(True)


class MaxLengthRule:
    """Check that a string doesn't exceed maximum length."""
    def __init__(self, max_length):
        self.max_length = max_length

    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)
        if len(str(value)) > self.max_length:
            return ValidationResult(
                False,
                f'Value is too long (maximum {self.max_length} characters)',
                'warning',
            )
        return ValidationResult(True)


class AlphanumericRule:
    """Check that a string contains only alphanumeric characters plus allowed chars."""
    def __init__(self, allow_chars='-/'):
        self.allow_chars = allow_chars

    def validate(self, value, _all_fields=None):
        if value is None:
            return ValidationResult(True)
        val_str = str(value)
        pattern = rf'^[a-zA-Z0-9{re.escape(self.allow_chars)}]+$'
        if not re.match(pattern, val_str):
            return ValidationResult(
                False,
                f'Value contains unexpected characters',
                'warning',
            )
        return ValidationResult(True)


class GreaterThanFieldRule:
    """Check that a numeric value is greater than another field's value."""
    def __init__(self, reference):
        self.reference = reference

    def validate(self, value, all_fields=None):
        if value is None or all_fields is None:
            return ValidationResult(True)
        ref_val = all_fields.get(self.reference)
        if ref_val is None:
            return ValidationResult(True)
        try:
            num = float(value)
            ref_num = float(ref_val)
        except (TypeError, ValueError):
            return ValidationResult(True)
        if num <= ref_num:
            return ValidationResult(
                False,
                f'Value ({num}) should be greater than {self.reference} ({ref_num})',
                'warning',
            )
        return ValidationResult(True)


class AfterFieldRule:
    """Check that a date is after another date field."""
    def __init__(self, reference):
        self.reference = reference

    def validate(self, value, all_fields=None):
        if value is None or all_fields is None:
            return ValidationResult(True)
        ref_val = all_fields.get(self.reference)
        if ref_val is None:
            return ValidationResult(True)
        dt = _parse_date_flexible(str(value))
        ref_dt = _parse_date_flexible(str(ref_val))
        if dt is None or ref_dt is None:
            return ValidationResult(True)
        if dt < ref_dt:
            return ValidationResult(
                False,
                f'Date should be after {self.reference}',
                'warning',
            )
        return ValidationResult(True)


# ---------------------------------------------------------------------------
# Validation Rules Configuration
# ---------------------------------------------------------------------------

VALIDATION_RULES = {
    'total_units': [
        NumericRule(min_val=0, max_val=100000),
        PositiveRule(),
        ReasonableRangeRule(
            typical_min=10, typical_max=5000,
            warning='Unusually high/low consumption',
        ),
    ],
    'bill_amount': [
        NumericRule(min_val=0, max_val=500000),
        PositiveRule(),
        ReasonableRangeRule(
            typical_min=50, typical_max=50000,
            warning='Bill amount outside typical range for Indian bills',
        ),
    ],
    'billing_date': [
        DateFormatRule(formats=['%d/%m/%Y', '%d-%m-%Y', '%B %Y', '%b %Y']),
        DateRangeRule(max_years_ago=2, max_years_future=1),
    ],
    'due_date': [
        DateFormatRule(formats=['%d/%m/%Y', '%d-%m-%Y']),
        AfterFieldRule(reference='billing_date'),
    ],
    'billing_month': [
        DateFormatRule(formats=['%B %Y', '%b %Y', '%m/%Y', '%m-%Y',
                                '%d/%m/%Y', '%d-%m-%Y']),
    ],
    'consumer_number': [
        MinLengthRule(4),
        MaxLengthRule(20),
        AlphanumericRule(allow_chars='-/'),
    ],
    'service_number': [
        MinLengthRule(3),
        MaxLengthRule(20),
        AlphanumericRule(allow_chars='-/'),
    ],
    'current_reading': [
        NumericRule(min_val=0),
        GreaterThanFieldRule(reference='previous_reading'),
    ],
    'previous_reading': [
        NumericRule(min_val=0),
    ],
}


# ---------------------------------------------------------------------------
# Main Validation Function
# ---------------------------------------------------------------------------

def validate_bill_data(extracted_data):
    """Validate all extracted bill fields against configured rules.

    Args:
        extracted_data: dict with field names as keys. Each value can be:
            - A plain value (str/int/float)
            - A dict with {'value': ..., 'confidence': ..., ...}

    Returns:
        dict: Validation results keyed by field name. Each value is:
            {
                'valid': bool,          # True if no errors (warnings OK)
                'warnings': [str],      # Warning messages
                'errors': [str],        # Error messages
                'details': [dict],      # Full validation result details
            }
    """
    results = {}

    # Extract plain values for cross-field validation
    plain_values = {}
    for field, val in extracted_data.items():
        if isinstance(val, dict):
            plain_values[field] = val.get('value')
        else:
            plain_values[field] = val

    for field, rules in VALIDATION_RULES.items():
        value = plain_values.get(field)
        field_results = []
        errors = []
        warnings = []

        for rule in rules:
            result = rule.validate(value, plain_values)
            field_results.append(result.to_dict())
            if not result.valid:
                if result.severity == 'error':
                    errors.append(result.message)
                elif result.severity == 'warning':
                    warnings.append(result.message)

        results[field] = {
            'valid': len(errors) == 0,
            'warnings': warnings,
            'errors': errors,
            'details': field_results,
        }

    return results


def compute_confidence_penalty(validation_results):
    """Compute a confidence penalty based on validation failures.

    Returns a dict mapping field names to confidence penalties (0-30 points).
    """
    penalties = {}
    for field, result in validation_results.items():
        penalty = 0
        if result['errors']:
            penalty += 20  # Hard errors get big penalty
        if result['warnings']:
            penalty += 10  # Warnings get smaller penalty
        penalties[field] = min(penalty, 30)  # Cap at 30
    return penalties


def cross_validate_readings(extracted_data):
    """Cross-validate meter readings against units consumed.

    If current_reading - previous_reading ≈ total_units, boost confidence.
    If they don't match, flag a warning.

    Returns:
        dict with 'consistent', 'computed_units', 'message'
    """
    plain = {}
    for field, val in extracted_data.items():
        if isinstance(val, dict):
            plain[field] = val.get('value')
        else:
            plain[field] = val

    current = plain.get('current_reading')
    previous = plain.get('previous_reading')
    total_units = plain.get('total_units')

    if current is None or previous is None:
        return {'consistent': None, 'computed_units': None,
                'message': 'Cannot cross-validate: missing readings'}

    try:
        curr = float(current)
        prev = float(previous)
    except (TypeError, ValueError):
        return {'consistent': None, 'computed_units': None,
                'message': 'Cannot cross-validate: non-numeric readings'}

    computed = curr - prev
    if computed < 0:
        return {
            'consistent': False,
            'computed_units': computed,
            'message': f'Current reading ({curr}) is less than previous ({prev})',
        }

    if total_units is None:
        return {
            'consistent': None,
            'computed_units': computed,
            'message': f'Computed units from readings: {computed}',
        }

    try:
        units = float(total_units)
    except (TypeError, ValueError):
        return {'consistent': None, 'computed_units': computed,
                'message': 'Cannot compare: non-numeric total_units'}

    # Allow 5% tolerance
    if units > 0 and abs(computed - units) / units <= 0.05:
        return {
            'consistent': True,
            'computed_units': computed,
            'message': f'Readings match: {curr} - {prev} = {computed} ≈ {units} units',
        }
    else:
        return {
            'consistent': False,
            'computed_units': computed,
            'message': (
                f'Readings mismatch: {curr} - {prev} = {computed}, '
                f'but bill says {units} units'
            ),
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_date_flexible(date_str):
    """Try to parse a date string using multiple formats."""
    if not date_str:
        return None
    date_str = date_str.strip()
    formats = [
        '%d/%m/%Y', '%d-%m-%Y', '%m/%d/%Y', '%m-%d-%Y',
        '%d/%m/%y', '%d-%m-%y',
        '%B %Y', '%b %Y', '%B-%Y', '%b-%Y',
        '%m/%Y', '%m-%Y',
        '%Y-%m-%d',
    ]
    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    # Try extracting month name + year
    match = re.search(
        r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
        r'[a-z]*[\s\-,]*(\d{4})',
        date_str, re.IGNORECASE,
    )
    if match:
        try:
            return datetime.strptime(f"{match.group(1)} {match.group(2)}", "%b %Y")
        except ValueError:
            pass
    return None
