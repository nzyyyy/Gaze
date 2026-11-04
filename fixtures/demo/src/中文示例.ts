import { Circle, Square, type Shape } from "./shapes";

export function totalArea(shapes: Shape[]): number {
  return shapes.reduce((total, shape) => total + shape.area(), 0);
}

// 😀 这个 emoji 位于调用之前，用于验证 UTF-16 位置转换。
const 图形 = [new Square(3), new Circle(2)];
export const 总面积 = totalArea(图形);
