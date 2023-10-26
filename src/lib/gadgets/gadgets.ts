/**
 * Wrapper file for various gadgets, with a namespace and doccomments.
 */
import { rangeCheck64 } from './range-check.js';
import { xor, rotate, leftShift, rightShift } from './bitwise.js';
import { Field } from '../core.js';

export { Gadgets };

const Gadgets = {
  /**
   * Asserts that the input value is in the range [0, 2^64).
   *
   * This function proves that the provided field element can be represented with 64 bits.
   * If the field element exceeds 64 bits, an error is thrown.
   *
   * @param x - The value to be range-checked.
   *
   * @throws Throws an error if the input value exceeds 64 bits.
   *
   * @example
   * ```ts
   * const x = Provable.witness(Field, () => Field(12345678n));
   * rangeCheck64(x); // successfully proves 64-bit range
   *
   * const xLarge = Provable.witness(Field, () => Field(12345678901234567890123456789012345678n));
   * rangeCheck64(xLarge); // throws an error since input exceeds 64 bits
   * ```
   *
   * **Note**: Small "negative" field element inputs are interpreted as large integers close to the field size,
   * and don't pass the 64-bit check. If you want to prove that a value lies in the int64 range [-2^63, 2^63),
   * you could use `rangeCheck64(x.add(1n << 63n))`.
   */
  rangeCheck64(x: Field) {
    return rangeCheck64(x);
  },

  /**
   * A (left and right) rotation operates similarly to the shift operation (`<<` for left and `>>` for right) in JavaScript, with the distinction that the bits are circulated to the opposite end rather than being discarded.
   * For a left rotation, this means that bits shifted off the left end reappear at the right end. Conversely, for a right rotation, bits shifted off the right end reappear at the left end.
   * It’s important to note that these operations are performed considering the binary representation of the number in big-endian format, where the most significant bit is on the left end and the least significant bit is on the right end.
   * The `direction` parameter is a string that accepts either `'left'` or `'right'`, determining the direction of the rotation.
   *
   * **Important:** The gadgets assumes that its input is at most 64 bits in size.
   *
   * If the input exceeds 64 bits, the gadget is invalid and does not prove correct execution of the rotation.
   * Therefore, to safely use `rotate()`, you need to make sure that the values passed in are range checked to 64 bits.
   * For example, this can be done with {@link Gadgets.rangeCheck64}.
   *
   * @param field {@link Field} element to rotate.
   * @param bits amount of bits to rotate this {@link Field} element with.
   * @param direction left or right rotation direction.
   *
   * @throws Throws an error if the input value exceeds 64 bits.
   *
   * @example
   * ```ts
   * const x = Provable.witness(Field, () => Field(0b001100)); // 12 in binary
   * const y = rot(x, 2, 'left'); // left rotation by 2 bits
   * const z = rot(x, 2, 'right'); // right rotation by 2 bits
   * y.assertEquals(0b110000); // 48 in binary
   * z.assertEquals(0b000011) // 3 in binary
   *
   * const xLarge = Provable.witness(Field, () => Field(12345678901234567890123456789012345678n));
   * rot(xLarge, 32, "left"); // throws an error since input exceeds 64 bits
   * ```
   */
  rotate(field: Field, bits: number, direction: 'left' | 'right' = 'left') {
    return rotate(field, bits, direction);
  },

  /**
   * Bitwise XOR gadget on {@link Field} elements. Equivalent to the [bitwise XOR `^` operator in JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Bitwise_XOR).
   * A XOR gate works by comparing two bits and returning `1` if two bits differ, and `0` if two bits are equal.
   *
   * This gadget builds a chain of XOR gates recursively. Each XOR gate can verify 16 bit at most. If your input elements exceed 16 bit, another XOR gate will be added to the chain.
   *
   * The `length` parameter lets you define how many bits should be compared. `length` is rounded to the nearest multiple of 16, `paddedLength = ceil(length / 16) * 16`, and both input values are constrained to fit into `paddedLength` bits. The output is guaranteed to have at most `paddedLength` bits as well.
   *
   * **Note:** Specifying a larger `length` parameter adds additional constraints.
   *
   * It is also important to mention that specifying a smaller `length` allows the verifier to infer the length of the original input data (e.g. smaller than 16 bit if only one XOR gate has been used).
   * A zkApp developer should consider these implications when choosing the `length` parameter and carefully weigh the trade-off between increased amount of constraints and security.
   *
   * **Important:** Both {@link Field} elements need to fit into `2^paddedLength - 1`. Otherwise, an error is thrown and no proof can be generated.
   *
   * For example, with `length = 2` (`paddedLength = 16`), `xor()` will fail for any input that is larger than `2**16`.
   *
   * @param a {@link Field} element to compare.
   * @param b {@link Field} element to compare.
   * @param length amount of bits to compare.
   *
   * @throws Throws an error if the input values exceed `2^paddedLength - 1`.
   *
   * @example
   * ```ts
   * let a = Field(5);      // ... 000101
   * let b = Field(3);      // ... 000011
   *
   * let c = xor(a, b, 2);  // ... 000110
   * c.assertEquals(6);
   * ```
   */
  xor(a: Field, b: Field, length: number) {
    return xor(a, b, length);
  },

  /**
   * Performs a left shift operation on the provided {@link Field} element.
   * This is akin to the `<<` shift operation in JavaScript, where bits are moved to the left.
   * The `leftShift` function uses the rotation method internally to achieve this operation.
   *
   * **Important:** The gadgets assumes that its input is at most 64 bits in size.
   *
   * If the input exceeds 64 bits, the gadget is invalid and does not prove correct execution of the rotation.
   * Therefore, to safely use `leftShift()`, you need to make sure that the values passed in are range checked to 64 bits.
   * For example, this can be done with {@link Gadgets.rangeCheck64}.
   *
   * @param field {@link Field} element to shift.
   * @param bits Amount of bits to shift the {@link Field} element to the left. The amount should be between 0 and 64 (or else the shift will fail).
   *
   * @throws Throws an error if the input value exceeds 64 bits.
   *
   * @example
   * ```ts
   * const x = Provable.witness(Field, () => Field(0b001100)); // 12 in binary
   * const y = leftShift(x, 2); // left shift by 2 bits
   * y.assertEquals(0b110000); // 48 in binary
   *
   * const xLarge = Provable.witness(Field, () => Field(12345678901234567890123456789012345678n));
   * leftShift(xLarge, 32); // throws an error since input exceeds 64 bits
   * ```
   */
  leftShift(field: Field, bits: number) {
    return leftShift(field, bits);
  },

  /**
   * Performs a right shift operation on the provided {@link Field} element.
   * This is similar to the `>>` shift operation in JavaScript, where bits are moved to the right.
   * The `rightShift` function utilizes the rotation method internally to implement this operation.
   *
   * **Important:** The gadgets assumes that its input is at most 64 bits in size.
   *
   * If the input exceeds 64 bits, the gadget is invalid and does not prove correct execution of the rotation.
   * Therefore, to safely use `rightShift()`, you need to make sure that the values passed in are range checked to 64 bits.
   * For example, this can be done with {@link Gadgets.rangeCheck64}.
   *
   * @param field {@link Field} element to shift.
   * @param bits Amount of bits to shift the {@link Field} element to the right. The amount should be between 0 and 64 (or else the shift will fail).
   *
   * @throws Throws an error if the input value exceeds 64 bits.
   *
   * @example
   * ```ts
   * const x = Provable.witness(Field, () => Field(0b001100)); // 12 in binary
   * const y = rightShift(x, 2); // right shift by 2 bits
   * y.assertEquals(0b000011); // 3 in binary
   *
   * const xLarge = Provable.witness(Field, () => Field(12345678901234567890123456789012345678n));
   * rightShift(xLarge, 32); // throws an error since input exceeds 64 bits
   * ```
   */
  rightShift(field: Field, bits: number) {
    return rightShift(field, bits);
  },
};
