if (!window.Eurus.loadedScript.has("quiz.js")) {
  window.Eurus.loadedScript.add("quiz.js");

  requestAnimationFrame(() => {
    document.addEventListener("alpine:init", () => {
      Alpine.data("xQuiz", (sectionId, maxProduct, defaultProductIds) => ({
        loading: false,
        cachedResults: [],
        hasProducts: true,
        totalQuestions: 0,
        curIndex: 0,
        questionIds: [],
        questionTypes: [],
        questionSkipIds: [],
        traversed: [],
        currentQuestionId: null,
        answers: new Map(),
        skips: new Map(),
        selectedOptions: new Map(),
        initHeight: 0,
        productNumQuiz: 0,
        hasVariant: false,
        init() {
          const questions = this.$el.querySelectorAll(".quiz-question");
          const startButton = this.$el.querySelector(
            `.button-quiz-${sectionId} button`
          );
          this.totalQuestions = questions.length;
          this.$nextTick(() => {
            this.questionIds = Array.from(questions).map(
              (q) => q.dataset.blockId
            );
            this.questionTypes = Array.from(questions).map(
              (q) => q.dataset.questionType
            );
            this.questionSkipIds = Array.from(questions).map(
              (q) => q.dataset.questionId
            );
            startButton.disabled = false;

            const ro = new ResizeObserver((entries) => {
              requestAnimationFrame(() => {
                this.initHeight = entries[0].borderBoxSize?.[0]?.blockSize ?? this.$el.offsetHeight;
                ro.disconnect();
              });
            });
            ro.observe(this.$el);
          });
        },

        _getSkippedIds() {
          const skipped = new Set();
          for (const skipMap of this.skips.values()) {
            for (const skipArr of skipMap.values()) {
              for (const id of skipArr) skipped.add(id);
            }
          }
          return skipped;
        },

        _getNextQuestionId(fromBlockId) {
          const skipped = this._getSkippedIds();
          const pos = fromBlockId ? this.questionIds.indexOf(fromBlockId) : -1;
          for (let i = pos + 1; i < this.questionIds.length; i++) {
            if (!skipped.has(this.questionSkipIds[i]))
              return this.questionIds[i];
          }
          return null;
        },

        _getPaginationWidth() {
          if (this.curIndex === 0) return 0;
          if (!this.currentQuestionId) return 100;
          const skipped = this._getSkippedIds();
          const pos = this.questionIds.indexOf(this.currentQuestionId);
          const remaining = this.questionSkipIds
            .slice(pos + 1)
            .filter((skipId) => !skipped.has(skipId)).length;
          const effectiveTotal = this.traversed.length + 1 + remaining;
          return effectiveTotal > 0
            ? ((this.traversed.length + 1) / (effectiveTotal + 1)) * 100
            : 0;
        },

        isLastQuestion() {
          return (
            this.currentQuestionId !== null &&
            this._getNextQuestionId(this.currentQuestionId) === null
          );
        },

        selectAnswer(questionId, value, skipQuestionsStr, optionBlockId) {
          const questionType =
            this.questionTypes[this.questionIds.indexOf(questionId)];
          const valueKey = JSON.stringify(value);
          const skipArr = skipQuestionsStr
            ? skipQuestionsStr
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [];

          if (!this.answers.has(questionId))
            this.answers.set(questionId, new Set());
          if (!this.selectedOptions.has(questionId))
            this.selectedOptions.set(questionId, new Set());
          if (!this.skips.has(questionId))
            this.skips.set(questionId, new Map());

          const answerSet = this.answers.get(questionId);
          const selectedSet = this.selectedOptions.get(questionId);
          const skipMap = this.skips.get(questionId);

          if (questionType === "single") {
            answerSet.clear();
            answerSet.add(valueKey);
            selectedSet.clear();
            if (optionBlockId) selectedSet.add(optionBlockId);
            skipMap.clear();
            if (optionBlockId) skipMap.set(optionBlockId, skipArr);
          } else {
            if (answerSet.has(valueKey)) {
              answerSet.delete(valueKey);
              selectedSet.delete(optionBlockId);
              skipMap.delete(optionBlockId);
            } else {
              answerSet.add(valueKey);
              if (optionBlockId) selectedSet.add(optionBlockId);
              if (optionBlockId) skipMap.set(optionBlockId, skipArr);
            }
          }

          const pos = this.questionIds.indexOf(questionId);
          for (let i = pos + 1; i < this.questionIds.length; i++) {
            this.answers.delete(this.questionIds[i]);
            this.skips.delete(this.questionIds[i]);
            this.selectedOptions.delete(this.questionIds[i]);
          }
        },

        hasCurrentAnswer() {
          const s = this.answers.get(this.currentQuestionId);
          return s ? s.size > 0 : false;
        },

        hasAnswer(questionId, value) {
          const s = this.answers.get(questionId);
          return s ? s.has(JSON.stringify(value)) : false;
        },

        getAnswer(questionId) {
          return this.answers.get(questionId);
        },

        _getAllAnswers() {
          return Array.from(this.answers.values()).flatMap((set) =>
            Array.from(set).map((s) => {
              const { "id": _, ...ans } = JSON.parse(s);
              return ans;
            })
          );
        },

        _filterAnswers(answers) {
          const scores = new Map();
          const exclude = new Set();
          for (const answer of answers) {
            for (const [key, ids] of Object.entries(answer)) {
              const numKey = Number(key);
              for (const id of ids) {
                if (numKey === 0) {
                  exclude.add(id);
                } else {
                  scores.set(id, (scores.get(id) ?? 0) + numKey);
                }
              }
            }
          }
          const sorted = Array.from(scores.entries())
            .filter(([id]) => !exclude.has(id))
            .sort(([, a], [, b]) => b - a);
          const cutoff = sorted[maxProduct - 1]?.[1];
          return sorted.filter(
            ([, score], i) => i < maxProduct || score === cutoff
          );
        },

        _collectResultHtml() {
          const allAnswered = [
            ...this.traversed,
            this.currentQuestionId,
          ].filter(Boolean);
          const items = allAnswered.flatMap((qBlockId) => {
            const optBlockIds = this.selectedOptions.get(qBlockId);
            if (!optBlockIds || optBlockIds.size === 0) return [];
            return Array.from(optBlockIds)
              .map((optBlockId) => {
                const descEl = document.getElementById(`option-description-${optBlockId}`);

                const html = descEl?.innerHTML?.trim() ?? "";
                if (html) return /<li[\s>]/i.test(html) ? html : `<li>${html}</li>`;

                const headingEl = document.getElementById(`option-heading-${optBlockId}`);
                const text = headingEl?.textContent?.trim() ?? "";

                return text ? `<li>${text}</li>` : "";
              })
              .filter(Boolean);
          });
          return items.length ? `<ul>${items.join("")}</ul>` : "";
        },

        _fetchRecommendedProduct() {
          const productEntries = this._filterAnswers(this._getAllAnswers());
          const productIds = [
            ...new Set(
              productEntries.length > 0
                ? productEntries.map(([id]) => id)
                : defaultProductIds
            ),
          ];

          if (productIds.length === 0) {
            this.hasProducts = false;
            this.curIndex = this.totalQuestions + 1;
            this.currentQuestionId = null;
            return;
          }

          const query = productIds.map((value) => "id:" + value).join(" OR ");
          const searchUrl = `${Shopify.routes.root}search?section_id=${sectionId}&type=product&q=${query}`;

          if (this.cachedResults[searchUrl]) {
            const resultHtml = this._collectResultHtml();
            const des = document.getElementById(`quiz-answer-product-list-${sectionId}`);
            if (des) {
              des.innerHTML = this.cachedResults[searchUrl];
              requestAnimationFrame(() => {
                this._renderAddAllButton(des);
                const textContainer = document.getElementById(
                  `quiz-answer-text-${sectionId}`
                );
                if (textContainer) textContainer.innerHTML = resultHtml;
                this.curIndex = this.totalQuestions + 1;
                this.currentQuestionId = null;
                this._scrollToTop();
                return true;
              });
            }
            return;
          }

          this.loading = true;

          const resultHtml = this._collectResultHtml();
          fetch(searchUrl)
            .then((response) => {
              if (!response.ok) throw new Error(response.status);
              return response.text();
            })
            .then((text) => {
              const html = new DOMParser().parseFromString(text, "text/html");
              const src = html.getElementById("quiz-answer-product-list");
              const des = document.getElementById(`quiz-answer-product-list-${sectionId}`);
              if (src && des) {
                const idToScore = new Map(
                  productEntries.map(([id, score]) => [String(id), score])
                );
                Array.from(src.children)
                  .sort(
                    (a, b) =>
                      (idToScore.get(b.id) ?? 0) - (idToScore.get(a.id) ?? 0)
                  )
                  .forEach((el) => {
                    el.classList.add(`quiz-score-${idToScore.get(el.id) ?? 0}`);
                    src.appendChild(el);
                  });
                des.innerHTML = src.innerHTML;
                this.cachedResults[searchUrl] = src.innerHTML;
                this._renderAddAllButton(des);
              }
            })
            .catch((error) => {
              throw error;
            })
            .finally(() => {
              const textContainer = document.getElementById(
                `quiz-answer-text-${sectionId}`
              );
              if (textContainer) textContainer.innerHTML = resultHtml;
              this.curIndex = this.totalQuestions + 1;
              this.currentQuestionId = null;
              this._scrollToTop();
              this.loading = false;
            });
        },

        _renderAddAllButton(productListContainer) {
          const addAllBtn = document.getElementById(`add-all-button-${sectionId}`);
          if (!addAllBtn) return;

          const products = Array.from(productListContainer.querySelectorAll('.recommended-product'))
            .filter((el) => 
              getComputedStyle(el).display !== 'none'
            );
          const hasUnavailable = products.some((el) => el.dataset.productAvailable === 'false');
          
          addAllBtn.disabled = hasUnavailable;
          if (!hasUnavailable) {
            this._renderVariantPopup(products);
          }
        },

        _renderVariantPopup(products) {
          const variantContainer = document.getElementById(`variant-container-${sectionId}`);
          if (!variantContainer) return;

          const filtered = products.filter((el) => el.dataset.noVariant === 'false');

          if (filtered.length === 0) return;

          this.hasVariant = true;
          variantContainer.innerHTML = filtered
            .map((el) => el.querySelector('.quiz-card-product')?.innerHTML ?? '')
            .join('');
          filtered.forEach((el) => el.querySelector('.quiz-card-product')?.remove());

          this.productNumQuiz = filtered.length;
          variantContainer.closest('.product-variant-modal')?.style.setProperty('--product-num', this.productNumQuiz);
        },

        reset(animDir) {
          const container = this.$el.closest('.section-quiz');

          const clipTo = `inset(0 0 calc(100% - ${this.initHeight}px) 0)`;

          const anim = container.animate(
            [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: clipTo }],
            { duration: 500, easing: 'ease-in-out' }
          );

          const variantContainer = document.getElementById(`variant-container-${sectionId}`);

          anim.onfinish = () => {
            this.curIndex = 0;
            this.hasProducts = true;
            this.traversed = [];
            this.currentQuestionId = null;
            this.answers = new Map();
            this.skips = new Map();
            this.selectedOptions = new Map();
            container.style.height = '';
            this.hasVariant = false;
            this.productNumQuiz = 0;
            if (variantContainer) variantContainer.innerHTML = '';
            anim.cancel();
            this._scrollToTop();
          };
        },

        _scrollToTop() {
          setTimeout(() => {
            document
              .getElementById(`shopify-section-${sectionId}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 500);
        },

        start() {
          const container = this.$el.closest('.section-quiz');

          const clipFrom = `inset(0 0 calc(100% - ${this.initHeight}px) 0)`;
            
          const firstId = this._getNextQuestionId(null);
          if (firstId) {
            this.currentQuestionId = firstId;
            this.curIndex = 1;
            this._scrollToTop();
          } else {
            this._fetchRecommendedProduct();
          }

          container.animate(
            [{ clipPath: clipFrom }, { clipPath: 'inset(0 0 0 0)' }],
            { duration: 500, easing: 'ease-in-out' }
          );
        },

        next() {
          const nextId = this._getNextQuestionId(this.currentQuestionId);
          if (nextId) {
            this.traversed.push(this.currentQuestionId);
            this.currentQuestionId = nextId;
            this.curIndex += 1;
            this._scrollToTop();
          } else {
            this._fetchRecommendedProduct();
          }
        },

        prev() {
          if (this.traversed.length === 0) return;
          this.currentQuestionId = this.traversed.pop();
          this.curIndex -= 1;
          this._scrollToTop();
        },
      }));
    });
  });
}
