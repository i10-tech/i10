// Arc components style themselves with CSS modules. Next declares these in each
// app, but this package type-checks on its own, so it needs its own copy.
declare module "*.module.css" {
  const classes: { readonly [key: string]: string }
  export default classes
}
