import { assessFoundation, ProjectBriefFields } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";

// P4: the needs read from the brief and the rules, each with the sentence it was found in.

const brief = (patch: Partial<ProjectBriefFields>) => ProjectBriefFields.parse({ goal: "Учёт задач", audience: "Я сам", integrations: "нет", ...patch });

describe("foundation assessment", () => {
  it("a small single-user app fits the checked profile", () => {
    expect(assessFoundation(brief({ scenarios: "Создать задачу, отметить выполненной", data: "Название и срок" }))).toMatchObject({ fit: "fits", needs: [] });
  });

  it("reads only the owner's answer in an interview line, never the question", () => {
    const asked = assessFoundation(brief({ audience: "Кто будет пользоваться приложением и какие роли им нужны? — Только я, один пекарь." }));
    expect(asked).toMatchObject({ fit: "fits", needs: [] });
    const answered = assessFoundation(brief({ audience: "Кто будет пользоваться приложением? — Пекари и администратор с отдельным входом." }));
    expect(answered.needs).toEqual([expect.objectContaining({ need: "roles", evidence: "Пекари и администратор с отдельным входом." })]);
  });

  it("names each need once with the sentence that shows it", () => {
    const result = assessFoundation(brief({
      goal: "Магазин книг. Покупатель оплачивает заказ картой.",
      scenarios: "Покупатель загружает фото чека. Менеджер видит новые заказы в реальном времени.",
      constraints: "Около 2 000 пользователей в день. Работа без интернета в складе.",
      data: "Письмо клиенту после покупки.",
    }));
    expect(result.fit).toBe("partial");
    expect(Object.fromEntries(result.needs.map((item) => [item.need, item.evidence]))).toEqual({
      payments: "Покупатель оплачивает заказ картой.",
      files: "Покупатель загружает фото чека.",
      realtime: "Менеджер видит новые заказы в реальном времени.",
      load: "Около 2 000 пользователей в день.",
      offline: "Работа без интернета в складе.",
      messages: "Письмо клиенту после покупки.",
    });
  });

  it("does not take what is out of scope, open or denied for a need", () => {
    const result = assessFoundation(brief({ outOfScope: "Оплата, роли, мобильное приложение", openQuestions: "Нужен ли вход по паролю?", scenarios: "Оплата не нужна. Без чата.", constraints: "10 пользователей" }));
    expect(result).toMatchObject({ fit: "fits", needs: [] });
  });

  it("reads roles from the rules and any filled integrations answer as a need", () => {
    const result = assessFoundation(brief({ integrations: "Выгружать отчёт в бухгалтерию" }), [{ title: "Скидка менеджера", statement: "Менеджер назначает скидку до 10%", role: "Менеджер, администратор", exceptions: "" }]);
    expect(result.needs.map((item) => [item.need, item.field])).toEqual([["integrations", "integrations"], ["roles", "rule"]]);
  });
});
