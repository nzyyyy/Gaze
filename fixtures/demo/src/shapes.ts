export interface Shape {
  name: string;
  area(): number;
}

export class Square implements Shape {
  readonly name = "square";

  constructor(private readonly side: number) {}

  area(): number {
    return this.side * this.side;
  }
}

export class Circle implements Shape {
  readonly name = "circle";

  constructor(private readonly radius: number) {}

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}
