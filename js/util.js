  const $ = id => document.getElementById(id);
  const clamp = (v,a,b) => v<a?a:v>b?b:v;
  const fmt = (v,d=2) => (v===null||v===undefined||Number.isNaN(v))?'—':v.toFixed(d);

export { $, clamp, fmt };
