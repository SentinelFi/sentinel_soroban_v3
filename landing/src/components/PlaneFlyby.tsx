/* Decorative pixel-plane fly-by with a contrail. Purely CSS-animated; the
   geometry (direction, timing, vertical band) lives in index.css.
   `back` is the second, slower pass that heads right-to-left. */
export default function PlaneFlyby({ back = false }: { back?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={back ? "plane-flyby plane-flyby-back" : "plane-flyby"}
    >
      <div>
        <img src="/favicon.png" alt="" />
        <span className="contrail" />
      </div>
    </div>
  );
}
