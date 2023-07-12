import { createForeignCurve } from './foreign-curve.js';
import { Fq } from '../bindings/crypto/finite_field.js';
import { Vesta as V } from '../bindings/crypto/elliptic_curve.js';
import { Provable } from './provable.js';
import { Field } from './field.js';
import { vestaParams } from './foreign-curve-params.js';

class Vesta extends createForeignCurve(vestaParams) {}

let g = { x: Fq.negate(1n), y: 2n, infinity: false };
let h = V.toAffine(V.negate(V.double(V.add(V.fromAffine(g), V.one))));
let scalar = Field.random().toBigInt();
let p = V.toAffine(V.scale(V.fromAffine(h), scalar));

function main() {
  Vesta.initialize();
  let g0 = Provable.witness(Vesta, () => new Vesta(g));
  let one = Provable.witness(Vesta, () => Vesta.generator);
  let h0 = g0.add(one).double().negate();
  Provable.assertEqual(Vesta, h0, new Vesta(h));

  h0.assertOnCurve();
  // TODO super slow
  // h0.checkSubgroup();

  let scalar0 = Provable.witness(Field, () => new Field(scalar)).toBits();
  // TODO super slow
  // let p0 = h0.scale(scalar0);
  // Provable.assertEqual(Vesta, p0, new Vesta(p));
}

Provable.runAndCheck(main);
let { gates } = Provable.constraintSystem(main);

let gateTypes: Record<string, number> = {};
for (let gate of gates) {
  gateTypes[gate.type] ??= 0;
  gateTypes[gate.type]++;
}

console.log(gateTypes);