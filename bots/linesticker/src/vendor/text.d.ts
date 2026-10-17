// Wrangler's Text rule (wrangler.toml) imports *.txt files as strings.
declare module "*.txt" {
  const text: string;
  export default text;
}
