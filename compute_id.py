import hashlib

key = b'opekkpahmiieibgjedfoopabpmmnhfhl'
digest = hashlib.sha256(key).digest()
print('SHA256 hex:', digest.hex())
print('Digest length:', len(digest), 'bytes')

# Use only first 16 bytes (128 bits) — Chrome uses 128 bits for extension ID
value = int.from_bytes(digest[:16], 'big')
digits = 'abcdefghijklmnop'  # 16 chars = base 16
result = ''
for i in range(32):
    idx = value % 16  # base 16, not 17
    result = digits[idx] + result
    value //= 16
    print(f'i={i}, v={value}, idx={idx}, d={digits[idx]}')
print('Extension ID:', result)
print('Length:', len(result))
print('Valid:', len(result) == 32 and all(c in digits for c in result))
